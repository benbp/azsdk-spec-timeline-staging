## Azure SDK Development Visualizer

This repo contains a website and data to represent azure sdk generation flows from typespec PR to language PR to merge and release.

### Hosting

The main site is hosted at [https://benbp.net/azsdk-spec-timeline](https://benbp.net/azsdk-spec-timeline)

The site is deployed automatically on pushes to main from the [azsdk-spec-timeline](https://github.com/benbp/azsdk-spec-timeline) repository.

The staging site is hosted at [https://benbp.net/azsdk-spec-timeline-staging](https://benbp.net/azsdk-spec-timeline-staging)

Staging is deployed automatically on pushes to main from the [azsdk-spec-timeline-staging](https://github.com/benbp/azsdk-spec-timeline-staging) repository.

```
# Deploy to main site
git remote add origin https://github.com/benbp/azsdk-spec-timeline.git
git push origin

# Deploy to staging site
git remote add staging https://github.com/benbp/azsdk-spec-timeline-staging.git
git push staging
```

### Development

This is almost an entirely vibe coded single page app. Beware.

See `.github/copilot-instructions.md` and `.github/skills` for relevant docs that can guide coding agents to make contributions. The conventions are set up to be auto-loaded with the github copilot cli. More exhaustive development docs can be found in the `.github/copilot-instructions.md` file.

Locally, the site can be tested via:

```bash
npx http-server . -p 8765
# Open http://localhost:8765
```

Agents use `playwright-cli` for testing.

### Dependencies

- github cli
- playwright-cli
- node/npm/npx
- azure cli with devops extension
