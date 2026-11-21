# Architecture

## Overview

```
                     ┌──────────────────────── browser (userscript) ───────────────────────┐
 Reddit page ──► scanner ──► pipeline (jobs) ──► research log (local, source of truth) ──► UI
   (dwell)          │            │    ▲                  │   ▲ pending reports            ▲
                    │            │    │ cached feed      │   │                            │ events
                    │            ▼    │                  ▼   │                            │
                    │      OpenAI / Tavily        community publisher ── knowledge (feed, trends cache)
                    │                                    │   (offline-first)   ▲
                    └────────────────────────────────────┼─────────────────────┼──────────────────────┘
                                                         ▼                     │
                                              community server (optional): reports → propositions →
                                              consensus → feed + event clustering → dashboard / API
```

**Core rule:** the research log is the single source of truth. Nothing depends on the community server being configured or reachable:
- analysis, duplicate detection, History, CSV and local narratives only need the log;
- publishing reads *pending* entries from the log whenever the server is reachable.

## Userscript modules (`userscript/src/`)

| Folder | Module | Responsibility |
|---|---|---|
| `core/` | `env.js` | **The only module touching `GM_*`** (storage, HTTP, menu, styles). This keeps everything else testable in Node. |
| | `events.js` | Synchronous event bus. The core emits; the UI subscribes, so business logic never imports UI code. |
| | `settings.js` | Defaults, persistence, storage keys, `settings:changed`. |
| | `util.js`, `logger.js` | Helpers, debug logging. |
| `text/` | `tokenize.js` | Tokeniser, guarded similarity, URL normalisation. |
| | `tone.js` | Local humour/sarcasm/satire signals, tone classes. |
| | `canonical.js` | Canonical claims and proposition keys. **Mirror of `rta_server/claimsig.py`.** |
| `reddit/` | `adapters.js` | Page adapters: new Reddit, old Reddit, legacy redesign. |
| | `enricher.js` | Batched `/by_id` lookups for full text, crossposts and engagement. |
| | `source.js` | Linked host and article kind (news / opinion / …). |
| `analysis/` | `llm.js` | OpenAI-compatible chat in JSON mode, and Tavily search. |
| | `prompts.js` | The extraction and audit prompts. |
| | `results.js` | Result record builders: audit, skip, reuse, community. |
| | `risk.js` | Effective risk, labels, proposition truth. |
| `store/` | `research-log.js` | The local research log, with per-post records, a compact index and publish state. |
| | `usage.js` | Daily spend and lifetime savings. |
| `community/` | `config.js` | Connection config, anonymous id, persisted status. |
| | `api.js` | HTTP client that records connectivity. |
| | `knowledge.js` | Cached feed of agreed mistruths and narratives, plus on-device matching. |
| | `publisher.js` | **Offline-first publishing** of pending reports. |
| `insights/` | `clustering.js` | JS port of the server's event clustering. |
| | `local-narratives.js` | Local narratives built from the research log. |
| | `outlets.js` | Lookups in `spec/outlets.json`. |
| `pipeline/` | `scanner.js` | Finds posts and tracks visibility and dwell. |
| | `jobs.js` | The job queue and the tiered analysis pipeline (below). |
| `ui/` | `panel.js` | Shadow-DOM shell, tabs, banners, footer and event wiring. |
| | `cards.js`, `pills.js`, `history.js`, `trends.js`, `settings-view.js`, `export.js` | Views. |
| | `styles/*.css` | Panel (Shadow DOM) and page (badge) styles. |
| | `index.js` | Boot and wiring. |

`npm run build` bundles `src/index.js` with esbuild into one readable (unminified) IIFE. The metadata block is generated from `package.json`.

### The analysis pipeline (`pipeline/jobs.js`)

Cheapest check first; every outcome is stored in the research log.

| Step | Check | Cost |
|---|---|---|
| 0 | This post is already in the research log | free |
| 1 | Satire subreddit; crosspost, same link or near-identical post (same tone framing) | free |
| 1b | Community list: the link is known to spread an agreed mistruth | free |
| 2 | Extraction call: claim, tone, canonical form, cited outlet, "same as an earlier claim?" | 1 small call |
| 2a | Evident joke not passed off as fact → stop | – |
| 2b | Same proposition (either stance) or same claim already audited locally → reuse | – |
| 2c | Community list: same proposition or a similar claim → community verdict | – |
| 3 | Web research (Tavily) and audit call | full check |

## Offline-first publishing

```
 result stored ──► isReportable? ──yes──► research log entry ps = PENDING (+ public post metadata)
                                                    │
  triggers: start-up · every 60 s · window "online" · new results · settings saved · "Publish now"
                                                    ▼
 flush(): configured & sharing? ─ cross-tab lock ─ oldest PENDING first (≤ 50 per request)
          │ build report from the stored record (hashes computed now, `day` = when the post was seen)
          ├─ 2xx            → SENT (reports the server calls invalid → REJECTED)
          │    over the daily quota (code "quota") → stay PENDING, pause until the
          │    server's reset time, status line "Daily sharing limit reached – N reports kept …"
          ├─ network/5xx/429→ keep PENDING, exponential back-off 30 s … 1 h, status "offline"
          ├─ 401/403        → keep PENDING, pause until settings change ("token rejected")
          └─ 422/other 4xx  → retry one report at a time → the refused one is REJECTED
```

A report is worth sending if it is a canonical claim judged false, or one whose proposition is already on the community list (a vote); jokes never qualify. Each entry's publish state is stored both in its record and in the index, and index merges between tabs keep the most advanced state.

With *Also share analyses made while offline or before I joined* switched off, only entries written after `communityJoinedAt` are sent.

## Storage (userscript manager, all keys prefixed `rta.`)

| Key | Content |
|---|---|
| `rta.settings` | Settings |
| `rta.log.<t3_id>` | `{ t, r, ps }`: result record (incl. `canon`, `report` context, `origin`) and publish state |
| `rta.idx` | Compact index, `id → [t, kind, risk, title, sub, tt, ct, url, dup, sat, fr, tc, ts, pk, st, cm, ps]` (append-only layout) |
| `rta.usage`, `rta.stats` | Daily spend, lifetime savings |
| `rta.clientId` | Random anonymous id (community) |
| `rta.community`, `rta.community.trends` | Cached feed / narratives |
| `rta.community.status`, `rta.community.lastPayload`, `rta.community.publishLock` | Connectivity and publishing state |
| `rta.cache`, `rta.outbox` | Legacy (v1.0 cache, v1.3–1.4 outbox). Migrated or drained automatically. |

## Server (`server/src/rta_server/`)

| Module | Responsibility |
|---|---|
| `app.py` | FastAPI app factory: validation, auth token, rate limits, endpoints, dashboard |
| `store.py` | SQLite: propositions and aliases, votes, sightings, posts (outlet and engagement), link reports, consensus, metrics, cluster cache |
| `claimsig.py` | Canonical claims and proposition keys (reference implementation) |
| `clustering.py` | Weighted-DBSCAN event clustering and severity |
| `outlets.py` | Outlet registry lookups (`spec/outlets.json`) |

## Cross-language contracts (`spec/`)

- `claim.schema.json` and `report.schema.json`, generated from the server's Pydantic models.
- `outlets.json`, the shared outlet / ownership-group registry.
- `canonical-vectors.json`, generated from the Python reference implementation. Both the Python tests and the JS unit tests must reproduce it exactly.

`python server/scripts/generate_spec.py` regenerates the generated files.
