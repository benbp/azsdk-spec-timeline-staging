/**
 * typespec-metadata.js
 *
 * Resolves TypeSpec project metadata: package names, service directories,
 * and repo mappings per SDK language. Supports local paths (with optional
 * tsp compile) and remote GitHub API fallback.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SDK_REPOS = {
  Python:     'Azure/azure-sdk-for-python',
  Java:       'Azure/azure-sdk-for-java',
  Go:         'Azure/azure-sdk-for-go',
  '.NET':     'Azure/azure-sdk-for-net',
  JavaScript: 'Azure/azure-sdk-for-js'
};

// Map TypeSpec emitter keys to canonical language names
const EMITTER_LANG_MAP = {
  '@azure-tools/typespec-python': 'Python',
  'python': 'Python',
  '@azure-tools/typespec-java': 'Java',
  'java': 'Java',
  '@azure-tools/typespec-go': 'Go',
  'go': 'Go',
  '@azure-typespec/http-client-csharp-mgmt': '.NET',
  'http-client-csharp-mgmt': '.NET',
  '@azure-tools/typespec-ts': 'JavaScript',
  'typescript': 'JavaScript'
};

function gh(args) {
  try {
    return execSync(`gh ${args}`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000
    }).trim();
  } catch (e) {
    return null;
  }
}

/**
 * Minimal YAML parser — handles flat key:value, nested blocks, and quoted strings.
 * Only parses what we need from tspconfig.yaml and typespec-metadata.yaml.
 */
function parseSimpleYaml(text) {
  const result = {};
  const stack = [{ obj: result, indent: -1 }];

  for (const rawLine of text.split('\n')) {
    // Skip empty lines and comments
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

    const indent = rawLine.search(/\S/);
    const line = rawLine.trim();

    // Pop stack to find parent at correct indent level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    let key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Strip surrounding quotes from key
    if ((key.startsWith('"') && key.endsWith('"')) ||
        (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1);
    }

    // Strip surrounding quotes from value
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (value === '' || value === null) {
      // Nested object
      const child = {};
      parent[key] = child;
      stack.push({ obj: child, indent });
    } else if (value === 'true') {
      parent[key] = true;
    } else if (value === 'false') {
      parent[key] = false;
    } else {
      parent[key] = value;
    }
  }

  return result;
}

/**
 * Resolve the TypeSpec project path to an absolute local path and spec-relative path.
 * Accepts:
 *   - Absolute path: /home/ben/azs/azure-rest-api-specs/specification/foo/Foo.Management
 *   - Relative spec path: specification/foo/Foo.Management
 *   - GitHub-style: Azure/azure-rest-api-specs/specification/foo/Foo.Management
 */
function resolveProjectPath(input) {
  // Strip trailing slashes
  input = input.replace(/\/+$/, '');

  // Extract the spec-relative path (specification/...)
  const specMatch = input.match(/(specification\/.+)/);
  const specRelPath = specMatch ? specMatch[1] : null;

  // Check if it's a local path that exists
  let localPath = null;
  if (fs.existsSync(input)) {
    localPath = path.resolve(input);
  } else if (specRelPath) {
    // Try common local base paths
    const bases = [
      process.env.SPEC_REPO_PATH,
      path.join(process.env.HOME || '', 'azs', 'azure-rest-api-specs')
    ].filter(Boolean);
    for (const base of bases) {
      const candidate = path.join(base, specRelPath);
      if (fs.existsSync(candidate)) {
        localPath = candidate;
        break;
      }
    }
  }

  return { localPath, specRelPath };
}

/**
 * Attempt to get metadata via the TypeSpec metadata emitter (local only).
 */
function tryMetadataEmitter(localPath) {
  const metadataPath = path.join(
    localPath, 'tsp-output', '@azure-tools', 'typespec-metadata', 'typespec-metadata.yaml'
  );

  // Check if metadata already exists
  if (fs.existsSync(metadataPath)) {
    console.error(`  Using existing metadata: ${metadataPath}`);
    return parseSimpleYaml(fs.readFileSync(metadataPath, 'utf-8'));
  }

  // Try to generate
  console.error(`  Attempting tsp compile with metadata emitter...`);
  try {
    execSync(
      'npx --yes --package @typespec/compiler -- tsp compile . --emit "@azure-tools/typespec-metadata"',
      { cwd: localPath, encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    if (fs.existsSync(metadataPath)) {
      console.error(`  Metadata generated successfully`);
      return parseSimpleYaml(fs.readFileSync(metadataPath, 'utf-8'));
    }
  } catch (e) {
    console.error(`  Metadata emitter not available: ${e.message?.slice(0, 100)}`);
  }
  return null;
}

/**
 * Parse tspconfig.yaml to extract package info per language.
 * This is the fallback when the metadata emitter is not available.
 */
function parseFromTspConfig(tspConfig) {
  const packages = {};
  const defaultServiceDir = tspConfig.parameters?.['service-dir']?.default || 'sdk/unknown';
  const options = tspConfig.options || {};

  for (const [emitterKey, emitterOpts] of Object.entries(options)) {
    const lang = EMITTER_LANG_MAP[emitterKey];
    if (!lang || !SDK_REPOS[lang]) continue;

    const serviceDir = emitterOpts['service-dir'] || defaultServiceDir;
    const outputDir = emitterOpts['emitter-output-dir'] || '';

    // Extract package directory from output-dir pattern like {output-dir}/sdk/foo/azure-mgmt-foo
    let packageDir = null;
    const dirMatch = outputDir.match(/\{output-dir\}\/(.*)/);
    if (dirMatch) {
      packageDir = dirMatch[1];
    }

    // Infer package name from various sources
    let packageName = null;
    if (emitterOpts.namespace) {
      packageName = emitterOpts.namespace;
    }
    if (emitterOpts.module) {
      // Go: module like github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/foo/armfoo
      packageName = emitterOpts.module;
    }
    if (emitterOpts['package-details']?.name) {
      // JS: @azure/arm-foo
      packageName = emitterOpts['package-details'].name;
    }

    packages[lang] = {
      name: packageName || 'unknown',
      serviceDir,
      packageDir: packageDir || serviceDir,
      repo: SDK_REPOS[lang],
      emitter: emitterKey
    };
  }

  return packages;
}

/**
 * Extract package info from typespec-metadata.yaml output.
 */
function parseFromMetadata(metadata) {
  const packages = {};
  const languages = metadata.languages || {};

  for (const [key, langInfo] of Object.entries(languages)) {
    const lang = EMITTER_LANG_MAP[langInfo.emitterName] || EMITTER_LANG_MAP[key];
    if (!lang || !SDK_REPOS[lang]) continue;

    const outputDir = (langInfo.outputDir || '').replace(/^\{output-dir\}\//, '');
    packages[lang] = {
      name: langInfo.packageName || langInfo.namespace || 'unknown',
      serviceDir: langInfo.serviceDir || 'sdk/unknown',
      packageDir: outputDir || langInfo.serviceDir || 'sdk/unknown',
      repo: SDK_REPOS[lang],
      emitter: langInfo.emitterName
    };
  }

  return packages;
}

/**
 * Infer the service name from the spec path.
 * e.g. specification/durabletask/DurableTask.Management → "DurableTask"
 */
function inferServiceName(specRelPath) {
  if (!specRelPath) return 'Unknown';
  const parts = specRelPath.split('/');
  // Find the TypeSpec project directory name (after specification/<service>/)
  // Common patterns:
  //   specification/durabletask/DurableTask.Management
  //   specification/netapp/resource-manager/Microsoft.NetApp/NetApp
  const last = parts[parts.length - 1];
  // Prefer the last segment, strip common prefixes
  return last
    .replace(/^Microsoft\./, '')
    .replace(/\.Management$/, '')
    .replace(/\.Mgmt$/, '');
}

/**
 * Fetch tspconfig.yaml from GitHub API when local file is unavailable.
 */
function fetchTspConfigFromGitHub(specRelPath) {
  console.error(`  Fetching tspconfig.yaml from GitHub: ${specRelPath}`);
  const encoded = encodeURIComponent(`${specRelPath}/tspconfig.yaml`).replace(/%2F/g, '/');
  const result = gh(`api "repos/Azure/azure-rest-api-specs/contents/${encoded}" --jq '.content'`);
  if (!result) return null;
  try {
    const decoded = Buffer.from(result.replace(/\s/g, ''), 'base64').toString('utf-8');
    return parseSimpleYaml(decoded);
  } catch (e) {
    console.error(`  Failed to decode tspconfig: ${e.message}`);
    return null;
  }
}

/**
 * Main entry point: resolve TypeSpec project metadata.
 *
 * @param {string} projectPath — local path, spec-relative path, or GitHub-style path
 * @returns {object} ServiceMetadata
 */
function resolve(projectPath) {
  console.error(`Resolving TypeSpec metadata for: ${projectPath}`);
  const { localPath, specRelPath } = resolveProjectPath(projectPath);

  let tspConfig = null;
  let metadata = null;
  let packages = {};

  // Try local first
  if (localPath) {
    console.error(`  Local path: ${localPath}`);

    // Try metadata emitter output
    metadata = tryMetadataEmitter(localPath);
    if (metadata) {
      packages = parseFromMetadata(metadata);
    }

    // Fallback to tspconfig.yaml
    if (Object.keys(packages).length === 0) {
      const configPath = path.join(localPath, 'tspconfig.yaml');
      if (fs.existsSync(configPath)) {
        console.error(`  Parsing tspconfig.yaml`);
        tspConfig = parseSimpleYaml(fs.readFileSync(configPath, 'utf-8'));
        packages = parseFromTspConfig(tspConfig);
      }
    }
  }

  // Remote fallback via GitHub API
  if (Object.keys(packages).length === 0 && specRelPath) {
    tspConfig = fetchTspConfigFromGitHub(specRelPath);
    if (tspConfig) {
      packages = parseFromTspConfig(tspConfig);
    }
  }

  const service = inferServiceName(specRelPath || projectPath);
  const namespace = metadata?.typespec?.namespace || null;

  const result = {
    service,
    specPath: specRelPath || projectPath,
    namespace,
    packages
  };

  console.error(`  Resolved: ${service} — ${Object.keys(packages).length} languages`);
  for (const [lang, pkg] of Object.entries(packages)) {
    console.error(`    ${lang}: ${pkg.name} (${pkg.packageDir})`);
  }

  return result;
}

module.exports = { resolve, parseSimpleYaml, SDK_REPOS, EMITTER_LANG_MAP };
