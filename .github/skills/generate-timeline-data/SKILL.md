---
name: generate-timeline-data
description: >
  Fetches PR data from the Azure SDK generation process and produces a structured
  timeline JSON for visualization. Use when asked to generate timeline data for an
  azure-rest-api-specs PR, or to analyze SDK generation timelines.
---

# Generate Azure SDK Timeline Data

This skill fetches PR data from the Azure SDK generation process and produces a structured timeline JSON that can be visualized with the timeline-viz website. Given a spec PR URL from `azure-rest-api-specs`, it discovers downstream SDK PRs, fetches all events, and analyzes them to identify bottlenecks, nags, manual fixes, and idle gaps.

## Instructions

You are an expert at analyzing Azure SDK generation timelines. The user will provide a PR link from the `Azure/azure-rest-api-specs` repository. Your job is to:

1. **Fetch raw data** using the fetch script or `gh` CLI commands
2. **Discover downstream SDK PRs** linked to the spec PR
3. **Classify all events** into timeline event types
4. **Analyze interactions** to detect nags, manual fixes, blocking comments, and idle gaps
5. **Generate insights** about bottlenecks and friction points
6. **Output** a complete timeline JSON matching the schema

### Step 1: Identify the Spec PR

Parse the user's input to extract the spec PR URL. Expected format:
`https://github.com/Azure/azure-rest-api-specs/pull/{number}`

### Step 2: Fetch Data

Use the fetch script if available:
```bash
node scripts/fetch-timeline.js <spec-pr-url> [--sdk-prs <url1> <url2> ...] [--release-csv /path/to/azure-sdk/_data/releases] [--skip-releases]
```

The script automatically fetches release data from Azure DevOps pipelines and optionally cross-references with the Azure SDK release CSVs. Use `--release-csv` to point to the `_data/releases` directory for CSV lookup. Use `--skip-releases` to skip release data entirely.

Or fetch manually with `gh` CLI:
```bash
# Spec PR metadata
gh api repos/Azure/azure-rest-api-specs/pulls/{number}

# Spec PR comments
gh api repos/Azure/azure-rest-api-specs/issues/{number}/comments --paginate

# Spec PR reviews
gh api repos/Azure/azure-rest-api-specs/pulls/{number}/reviews --paginate

# Spec PR review comments (inline threads)
gh api repos/Azure/azure-rest-api-specs/pulls/{number}/comments --paginate

# Spec PR commits
gh api repos/Azure/azure-rest-api-specs/pulls/{number}/commits --paginate
```

### Step 3: Discover SDK PRs

SDK PRs can be found using multiple strategies (try in order):

1. **Search by spec PR URL in PR bodies** — this works for BOTH automated (AutoPR bot) and manual (human-authored) flows:
```bash
gh api "search/issues?q=repo:Azure/azure-sdk-for-java+azure-rest-api-specs/pull/{number}+is:pr&per_page=5"
gh api "search/issues?q=repo:Azure/azure-sdk-for-go+azure-rest-api-specs/pull/{number}+is:pr&per_page=5"
gh api "search/issues?q=repo:Azure/azure-sdk-for-python+azure-rest-api-specs/pull/{number}+is:pr&per_page=5"
gh api "search/issues?q=repo:Azure/azure-sdk-for-net+azure-rest-api-specs/pull/{number}+is:pr&per_page=5"
gh api "search/issues?q=repo:Azure/azure-sdk-for-js+azure-rest-api-specs/pull/{number}+is:pr&per_page=5"
```

2. **Search by merge commit SHA** — newer AutoPR PRs include `CommitSHA: '{sha}'` in their body instead of the spec PR URL. First get the spec PR merge commit SHA, then search for it:
```bash
# Get spec PR merge commit SHA
gh api repos/Azure/azure-rest-api-specs/pulls/{number} --jq '.merge_commit_sha'
# Search for it in SDK PR bodies
gh api "search/issues?q=repo:Azure/azure-sdk-for-java+{sha}+is:pr&per_page=5"
```

3. **Search by service name** — use the tspconfig path from the spec PR to derive the service name, then search for AutoPR titles or body content:
```bash
gh api "search/issues?q=repo:Azure/azure-sdk-for-java+{serviceName}+author:azure-sdk+is:pr&per_page=5"
```

4. **The user may also provide SDK PR URLs directly** — use those if given. This is the most reliable method when available.

**IMPORTANT**: When results are found via strategy 2 or 3, always verify the SDK PR actually references the correct spec PR. Check the body for matching commit SHAs, build IDs, or spec PR URLs. Newer AutoPR PRs may reference builds (e.g. `Created based on https://dev.azure.com/...builds?buildId=NNNNNN`) instead of spec PR URLs.

5. **Detect generation flow type** — for each discovered SDK PR:
   - If the title starts with `[AutoPR ` or the author is `azure-sdk` → `generationFlow: "automated"`
   - Otherwise → `generationFlow: "manual"` (human-authored PR)
   - This distinction is important: some flows are mixed (e.g., automated for most languages but manual for one)

6. **If a language has no SDK PR**, include an empty placeholder in the output:
```json
{
  "repo": "Azure/azure-sdk-for-net",
  "language": ".NET",
  "number": null,
  "url": null,
  "title": "No SDK PR generated",
  "author": null,
  "createdAt": null,
  "mergedAt": null,
  "state": "missing",
  "generationFlow": null,
  "events": []
}
```

For each discovered SDK PR, fetch the same data (metadata, comments, reviews, review comments, commits).

**IMPORTANT**: Include closed (not merged) SDK PRs too — they tell an important story. For example, AutoPR may generate PRs that are later closed without merge (superseded by manual PRs or newer generation runs). These show up as `state: "closed"` and should have `pr_closed` events. Including them helps visualize the full picture of what happened.

### Steps 4–6: Process Raw Data into Timeline JSON

After fetching raw data (Step 2) and discovering SDK PRs (Step 3), use the processing script to classify events, perform AI analysis, and generate insights in one step:

```bash
node scripts/process-timeline.js <raw-json> <output-json> <title>
```

For example:
```bash
# Fetch raw data first
node scripts/fetch-timeline.js https://github.com/Azure/azure-rest-api-specs/pull/41510 \
  --sdk-prs https://github.com/Azure/azure-sdk-for-java/pull/48467 \
  --skip-releases > /tmp/raw.json

# Process into final timeline JSON
node scripts/process-timeline.js /tmp/raw.json data/sample-keyvault-secrets.json "KeyVault Secrets SDK Generation"
```

The processing script automatically:
- Classifies all events into timeline event types (Step 4)
- Detects author nags, manual fixes, and sentiment (Step 5)
- Computes idle gaps (>24h between events)
- Generates insights about bottlenecks, open PRs, and summary stats (Step 6)
- Adds missing language placeholders for any of the 5 standard languages (Java, Go, Python, .NET, JavaScript) not present in the SDK PRs

After processing, **audit the output** — verify PR states, event counts, and insights match what you see on GitHub. Fix any issues in the raw data or re-fetch if needed.

The sections below document the classification and analysis rules implemented by the script, for reference and manual overrides.

### Step 4: Classify Events

For each PR, create timeline events from the raw data. Map each raw data item to one of these event types:

| Raw Data | Event Type | How to Detect |
|---|---|---|
| PR metadata `created_at` | `pr_created` | Always the first event |
| PR metadata `merged_at` | `pr_merged` | If PR is merged |
| PR metadata `closed_at` | `pr_closed` | If PR is closed without merge |
| Commits | `commit_pushed` | Each commit after PR creation |
| Review with state=APPROVED | `review_approved` | Review state is APPROVED |
| Review with state=CHANGES_REQUESTED | `review_changes_requested` | Review state is CHANGES_REQUESTED |
| Review with state=COMMENTED | `review_comment` | Review state is COMMENTED with body |
| Inline review comment | `review_comment` | From review comments/threads |
| Issue comment by human | `issue_comment` | Comment by non-bot user |
| Issue comment by bot | `bot_comment` | Comment by user with `[bot]` suffix or known bots |
| *See analysis below* | `author_nag` | AI-detected from comment text |
| *See analysis below* | `manual_fix` | AI-detected from comment text |
| *Computed* | `idle_gap` | Time gaps >24h between consecutive events |

### Step 5: AI Analysis

#### Detecting Author Nags (`author_nag`)

Look for comments by the spec PR author (the "owner") that:
- @ mention another user AND ask them to review, approve, merge, or take action
- Contain phrases like: "could you check", "can you merge", "please review", "can you approve", "could you approve", "please merge", "can you take a look"
- The `targetUser` should be the @ mentioned user

#### Detecting Manual Fixes (`manual_fix`)

Look for comments where the owner mentions doing manual work on an auto-generated PR:
- "manually edited", "manually ran", "manual intervention", "had to manually", "not passing without manual"
- These indicate the SDK code generation pipeline produced incomplete output

#### Determining Sentiment

- `positive`: approvals, LGTM, merge events, unblocking comments
- `negative`: nags, manual fixes needed
- `blocking`: review comments that ask for changes, questions that must be answered before merge
- `neutral`: informational comments, bot output, status updates

#### Computing Idle Gaps

1. Sort all events for each PR by timestamp
2. Find consecutive events where the gap is > 24 hours
3. Create `idle_gap` events with:
   - `timestamp`: end of previous event
   - `endTimestamp`: start of next event
   - `durationHours`: gap duration in hours
   - `sentiment`: "blocking" if > 72h, "neutral" if 24-72h

### Step 6: Generate Insights

Analyze the complete timeline and generate insights:

1. **Pipeline gap**: Time between spec PR merge and first SDK PR creation
2. **Spec PR review wait**: Time from spec PR creation to first human review
3. **Author nag count**: How many times the owner had to nudge reviewers
4. **Manual fixes on auto PRs**: How many automated SDK PRs needed manual intervention (manual_fix events)
5. **PR edits on manual PRs**: Count subsequent commits (excl. merge commits from main) on manual (human-authored) SDK PRs — these indicate iteration/rework cycles
6. **Slowest/fastest SDK PR**: Which language took longest/shortest
7. **Reviewer bottlenecks**: Which reviewers were slow to respond
8. **Positive patterns**: What went well (e.g., fast approvals)

### Step 7: Output JSON

The processing script (`scripts/process-timeline.js`) produces this JSON automatically. When running manually or auditing, ensure the output matches this schema:

```json
{
  "title": "<spec PR title>",
  "owner": "<spec PR author>",
  "startDate": "<earliest event timestamp>",
  "endDate": "<latest event timestamp>",
  "specPR": {
    "repo": "Azure/azure-rest-api-specs",
    "number": "<number>",
    "url": "<url>",
    "title": "<title>",
    "author": "<author>",
    "createdAt": "<iso8601>",
    "mergedAt": "<iso8601 or null>",
    "mergedBy": "<username or null>",
    "state": "merged|closed|open",
    "labels": ["..."],
    "reviewers": ["..."],
    "events": [
      {
        "type": "<event_type>",
        "timestamp": "<iso8601>",
        "actor": "<username>",
        "actorRole": "author|reviewer|bot|copilot",
        "description": "<short description>",
        "sentiment": "neutral|positive|negative|blocking",
        "details": {
          "body": "<full comment text if applicable>",
          "url": "<github link>",
          "targetUser": "<@ mentioned user if applicable>",
          "durationHours": "<number if idle_gap>"
        }
      }
    ]
  },
  "sdkPRs": [ "/* same structure per SDK PR, with added 'language' and 'generationFlow' fields. generationFlow is 'automated' for AutoPR bot PRs or 'manual' for human-authored PRs */" ],
  "insights": [
    {
      "type": "bottleneck|nag|manual_fix|idle|positive|summary|release_delay|release_pending",
      "severity": "info|warning|critical",
      "description": "<human-readable insight>",
      "durationDays": "<number if applicable>",
      "prRef": "<repo#number if applicable>"
    }
  ],
  "summary": {
    "totalDurationDays": "<number>",
    "specPRDays": "<number>",
    "pipelineGapDays": "<number>",
    "sdkPRMaxDays": "<number>",
    "fastestSDKPR": { "language": "<lang>", "days": "<number>" },
    "slowestSDKPR": { "language": "<lang>", "days": "<number>" },
    "totalUniqueReviewers": "<number>",
    "totalNags": "<number>",
    "totalManualFixes": "<number — manual_fix events on automated PRs>",
    "totalPREdits": "<number — subsequent commits excl. merge commits on manual PRs>",
    "avgReleaseGapDays": "<number or omit>",
    "maxReleaseGapDays": "<number or omit>",
    "pendingReleases": "<number or omit>"
  }
}
```

Each SDK PR object should also include an optional `release` field:
```json
{
  "release": {
    "packageName": "<package name on package manager>",
    "packageVersion": "<released version>",
    "pipelineName": "<DevOps pipeline name e.g. 'java - durabletask'>",
    "pipelineUrl": "<DevOps pipeline run URL>",
    "buildId": "<DevOps build ID>",
    "releasedAt": "<ISO 8601 timestamp when package was published, or null>",
    "releaseGapDays": "<days from PR merge to package publish>",
    "status": "released|pending|failed"
  }
}
```

Save the output to a file (e.g., `data/timeline-<name>.json`) and tell the user they can open `index.html` and load the file, or place it as `data/sample-durabletask.json` to make it the default.

### Step 8: Look Up Release Data

After determining PR merge dates, check whether each SDK package was actually released.

#### 8a. Find Release Pipeline in Azure DevOps

Pipeline names follow the pattern `<lang> - <service>` (sometimes with `-mgmt` suffix):

| Language | Pattern | Example |
|---|---|---|
| Java | `java - <service>` | `java - durabletask` |
| Go | `go - arm<service>` | `go - armdurabletask` |
| Python | `python - <service>` | `python - durabletask` |
| .NET | `net - <service> - mgmt` or `net - <service>` | `net - durabletask - mgmt` |
| JS | `js - <service> - mgmt` or `js - <service>` | `js - durabletask - mgmt` |

The service name comes from the AutoPR title: `[AutoPR azure-resourcemanager-<service>]` → service is `durabletask`.

```bash
# Find pipeline definition
az devops invoke --area build --resource definitions \
  --organization https://dev.azure.com/azure-sdk \
  --route-parameters project=internal \
  --query-parameters "name=java - durabletask" \
  --output json

# Find release builds (reason=manual means release trigger)
az devops invoke --area build --resource builds \
  --organization https://dev.azure.com/azure-sdk \
  --route-parameters project=internal \
  --query-parameters "definitions=<defId>" "\$top=100" "queryOrder=finishTimeDescending" \
  --output json
# Filter for reason=manual AND result=succeeded AND finishTime after PR merge date

# Get release stage timing
az devops invoke --area build --resource timeline \
  --organization https://dev.azure.com/azure-sdk \
  --route-parameters project=internal buildId=<buildId> \
  --output json
# Find the Stage record with "releas" in its name (case-insensitive)
# Use the finishTime of that stage as the actual release timestamp
# If result=skipped, the release was NOT actually published
```

#### 8b. Cross-reference with Azure SDK Release CSVs

Release CSV data is at `/home/ben/azs/azure-sdk/_data/releases/`:
- `latest/<lang>-packages.csv` has `Package`, `VersionGA`, `LatestGADate` (MM/DD/YYYY)
- `<YYYY-MM>/<lang>.yml` has monthly entries with package name, version, changelog

Package name patterns in the CSV:
| Language | Package Name Pattern | Example |
|---|---|---|
| Java | `azure-resourcemanager-<service>` | `azure-resourcemanager-durabletask` |
| Python | `azure-mgmt-<service>` | `azure-mgmt-durabletask` |
| .NET | `Azure.ResourceManager.<Service>` | `Azure.ResourceManager.DurableTask` |
| JS | `@azure/arm-<service>` | `@azure/arm-durabletask` |
| Go | `sdk/resourcemanager/<service>/arm<service>` | `sdk/resourcemanager/durabletask/armdurabletask` |

#### 8c. Determine Release Status

For each SDK PR:
1. If the DevOps release stage `result=succeeded` with a `finishTime`, status is `released`
2. If the release stage `result=skipped`, status is `pending` (merged but not published)
3. If no release pipeline/build found, status is `pending`
4. If the release stage `result=failed`, status is `failed`

Add `release_pipeline_started` and `release_pipeline_completed` (or `release_pipeline_failed`) events.
For merged PRs with no release, add a `release_pending` event.

#### 8d. Generate Release Insights

- **Release delay**: If `releaseGapDays > 3`, generate a `release_delay` insight
- **Pending releases**: If any SDK PR has `status=pending`, generate a `release_pending` insight (critical severity)
- **Failed releases**: Generate critical insight for failed pipeline runs

### Actor Role Classification

- `author`: The spec PR owner (the human driving the process) — even on SDK PRs
- `reviewer`: Human reviewers who are NOT the spec PR owner
- `bot`: Users with `[bot]` suffix, or known bot accounts like `azure-sdk`, `github-actions[bot]`
- `copilot`: `copilot-pull-request-reviewer[bot]` or `Copilot`

### Known Bot Accounts
- `azure-sdk`
- `github-actions[bot]`
- `azure-pipelines[bot]`
- `copilot-pull-request-reviewer[bot]`
- `Copilot`
- `msftbot[bot]`
