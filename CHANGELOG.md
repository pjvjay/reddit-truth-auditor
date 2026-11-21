# Changelog

All notable changes to this project. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Reports over the server's daily quota are no longer lost.** The server marks them with `code: "quota"` and says when the quota resets; the userscript keeps them queued, shows *Daily sharing limit reached – N reports kept…* in the footer and Settings, and sends them after the reset. Before, they were marked rejected and never sent.
- Rejections in the `POST /v1/reports` response now give the report's position in the request (it was off by the number of jokes dropped earlier in the same batch), and each has a `code` (`quota`, `invalid` or `joke`).
- **Two tabs sending the same reports.**
  - The publish lock now uses the browser's Web Locks API first, which is exclusive between tabs on the same Reddit host. The storage lease remains as a second, best-effort layer for tabs on different hosts and for browsers without Web Locks, and is renewed during long runs.
  - A tab now checks what other tabs have already sent before it chooses what to send. Before, a tab would send again whatever was still marked pending in its own copy of the index.
  - The server no longer counts a repeated report (same client, proposition and post) against the daily quota, and reports the number in `duplicates`. Reports it rejects as invalid are not counted either.
- `npm run test:unit` now runs on Node 18 and 20 too. The test file pattern was quoted, which only Node 21 and later expand, so the CI job on Node 20 found no tests.

### Changed
- The documentation no longer says two tabs never send the same reports. See *Several tabs* in `docs/architecture.md` for what is and is not guaranteed.

## [2.0.0] – offline-first, restructured project

### Added
- **Offline-first community publishing.** Results are queued in the research log as *pending*, with the post metadata needed to build the report later, whether or not a server is configured or reachable.
  - Publishing runs on start-up, every minute, when the browser comes back online, on new results, after settings change, or on demand.
  - Exponential back-off; auth errors pause without losing data; refused reports are isolated; a best-effort cross-tab lock makes duplicate sends less likely.
  - Reports keep the day the post was *seen*.
- The connection state and queue are shown in the footer and Settings, with **Publish now** and **Discard queue**, plus an offline banner.
- *Also share analyses made while offline or before I joined* setting.
- **Trends works offline:** cached community narratives, plus **My history** narratives clustered on-device from your own research log (a JS port of the server's clustering).
- `spec/`: JSON Schemas of the claim and report formats, the shared outlet registry, and cross-language test vectors.
- Unit tests (`node --test`), ESLint, CI workflow, server Dockerfile and `rta-server` CLI.

### Changed
- **Userscript:**
  - Split from one 3,000-line file into ES modules under `userscript/src`, bundled by esbuild into a readable `dist/reddit-truth-auditor.user.js`.
  - The metadata is generated from `package.json`, and updates are checked through a small `.meta.js` file.
  - The install URL moved to `dist/`.
- **Server:**
  - Now a Python package (`server/src/rta_server`, `pyproject.toml`), run with `rta-server` or uvicorn `--factory`.
  - Accepts sighting days up to `RTA_MAX_REPORT_AGE_DAYS` (default 30) back, for offline backlogs.
- The consensus verdict sentence is the one most reporters agree on (deterministic).
- Batch scripts moved to `batch/` (superseded versions in `batch/legacy/`). `finalrun.py` now uses today's date instead of a hard-coded one.

### Migration
- Automatic: the research log gains a publish state; the v1.3–1.4 outbox is drained first; v1.0 cache is folded in as before.

## [1.4.0]
- Event clustering of propagating false claims (weighted DBSCAN), biased towards claims carried by independent outlets (ownership groups) and popular posts. Severity scores, a Trends tab and narrative notes on posts.

## [1.3.0]
- Canonical claims and proposition keys; opt-in community network (anonymous reports, consensus feed, on-device matching); reference server.

## [1.2.0]
- Humour, sarcasm and satire detection; tone-aware duplicate matching.

## [1.1.0]
- Persistent research log, tiered duplicate detection, History tab.

## [1.0.0]
- First userscript: dwell-based fact-checking, side panel, configurable risk threshold, badges, CSV export.
