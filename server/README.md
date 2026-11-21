# rta-community-server

Reference implementation of the Reddit Truth Auditor **community API**. It accepts anonymous reports of mistruths, builds a consensus, clusters related false claims into narratives with severity scores, and serves the agreed list back to userscripts.

Protocol, consensus, clustering and privacy model: **[docs/community-api.md](../docs/community-api.md)**.

## Run

```bash
pip install ./server                    # Python ≥ 3.10
rta-server --host 0.0.0.0 --port 8080 --db /var/lib/rta/community.sqlite3
# dashboard: http://localhost:8080/    API docs: http://localhost:8080/docs
```

Or with Docker (build from the repository root – the image needs `spec/outlets.json`):

```bash
docker build -f server/Dockerfile -t rta-community-server .
docker run -p 8080:8080 -v rta-data:/data rta-community-server
```

Put it behind HTTPS (any reverse proxy) for real use. Set `FORWARDED_ALLOW_IPS` to your proxy's address so per-IP rate limits see client addresses.

## Configuration

| Variable | Default | |
|---|---|---|
| `RTA_DB` | `rta-community.sqlite3` | SQLite file (WAL mode) |
| `RTA_FEED_MIN_CLIENTS` | `3` | Independent reporters needed before a claim or cluster is published |
| `RTA_PUBLISH_TOKENS` | – | Comma-separated. If set, `POST /v1/reports` requires `X-RTA-Token`. |
| `RTA_MAX_REPORTS_PER_DAY` | `2000` | Per anonymous client id |
| `RTA_MAX_REPORT_AGE_DAYS` | `30` | Oldest sighting day accepted (clients publish offline backlogs) |
| `RTA_IP_RATE_PER_MIN` | `120` | POSTs per IP per minute (in memory; IPs are never stored) |
| `RTA_CORS_ORIGINS` | `*` | For browser dashboards |
| `RTA_CLUSTER_*` | | Clustering parameters – see [docs/community-api.md §8](../docs/community-api.md#8-configuration) |

## Develop

```bash
pip install -e "server[dev]"
python -m pytest server/tests -q
rta-server --reload
```

The package lives in `src/rta_server/`:
- `app.py`: API and dashboard;
- `store.py`: SQLite, consensus and metrics;
- `claimsig.py`: proposition keys;
- `clustering.py`: event clustering and severity;
- `outlets.py`: outlet registry.
