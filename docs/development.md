# Development

## Setup

```bash
npm install                                  # esbuild, eslint, prettier
pip install -e "server[dev]" playwright      # server + test dependencies
python -m playwright install chromium
```

## Everyday commands

| Command | What it does |
|---|---|
| `npm run build` | Bundles `userscript/src` into `dist/reddit-truth-auditor.user.js` (+ `.meta.js`) |
| `npm run watch` | Rebuilds on change. Load `dist/…user.js` in Tampermonkey via a local file URL, or paste it in. |
| `npm run lint` | ESLint over the userscript sources |
| `npm run test:unit` | Node unit tests (`userscript/test/unit`, no browser): text/tone/risk, research log, **offline-first publisher**, local clustering, CSV, cross-language vectors |
| `npm run test:e2e` | End-to-end tests against the **built** `dist/` file: headless Chromium, mock Reddit pages (new + old UI), mocked OpenAI/Tavily, the real community server in-process |
| `npm run test:server` | Server tests (`server/tests`): API, consensus, clustering, spec vectors |
| `python server/scripts/generate_spec.py` | Regenerates `spec/canonical-vectors.json` and the JSON Schemas |

Set `RTA_SHOTS=/some/dir` to choose where the end-to-end tests save screenshots.

## Conventions

- **Only `core/env.js` may touch `GM_*`**, and only the UI touches the panel DOM. Core modules communicate with the UI through `core/events.js`.
- **No `innerHTML`.** Build DOM with `ui/dom.js#h`, which treats text as text. Post titles and model output are untrusted.
- **Protocol changes are cross-language.** Changes to `text/canonical.js` or `text/tokenize.js` must be mirrored in `server/src/rta_server/claimsig.py`, followed by regenerating the vectors. Both test suites then check parity.
- **Storage layouts are append-only.** Add fields at the end of the research-log index (`FIELDS` in `store/research-log.js`) and write a migration for anything else.
- `dist/` is committed so the install and update URLs work. CI fails if it is out of date.

## Releasing

1. Bump `version` in `package.json`, `server/pyproject.toml` and `server/src/rta_server/__init__.py`.
2. Add an entry to `CHANGELOG.md`.
3. Run `npm run build && npm test && npm run test:server`.
4. Commit `dist/` and tag `vX.Y.Z`. Tampermonkey users update automatically via `@updateURL`, which points to `dist/reddit-truth-auditor.meta.js` on `main`.

To publish on [Greasy Fork](https://greasyfork.org), import `dist/reddit-truth-auditor.user.js` from the raw GitHub URL with sync enabled. The bundle is intentionally unminified, as Greasy Fork's rules require.
