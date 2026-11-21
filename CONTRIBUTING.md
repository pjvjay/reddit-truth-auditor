# Contributing

Thanks for helping! Bug reports, outlet-registry updates and pull requests are welcome.

1. **Discuss larger changes first** in an issue.
2. Set up: see [docs/development.md](docs/development.md).
3. Before opening a PR, run `npm run lint && npm run test:unit && npm run build && npm run test:e2e && npm run test:server`, and commit the rebuilt `dist/` files.
4. Keep to the [conventions](docs/development.md#conventions):
   - only `core/env.js` touches `GM_*`;
   - no `innerHTML`;
   - mirror any canonical-claim changes on the server and regenerate `spec/` vectors;
   - storage layouts are append-only.
5. Add a `CHANGELOG.md` entry under an *Unreleased* heading.

### Updating the outlet registry

Edit `spec/outlets.json`:
- `group` is the **ownership group**, the unit of independence;
- `tier` describes reach (1 major, 2 established, 3 small), not quality or political lean.

Please cite a source for ownership changes in the PR description.

### Reporting Reddit markup changes

If badges stop appearing, open an issue with the page URL type (feed, subreddit, post, old.reddit) and, ideally, the outer HTML of one post element.
