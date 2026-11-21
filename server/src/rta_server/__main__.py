"""`python -m rta_server` / `rta-server` - run the community API with uvicorn."""
import argparse
import os


def main() -> None:
    parser = argparse.ArgumentParser(prog="rta-server", description="Reddit Truth Auditor community API")
    parser.add_argument("--host", default=os.environ.get("RTA_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("RTA_PORT", "8080")))
    parser.add_argument("--db", default=None, help="SQLite file (default: $RTA_DB or ./rta-community.sqlite3)")
    parser.add_argument("--reload", action="store_true", help="auto-reload on code changes (development)")
    args = parser.parse_args()
    if args.db:
        os.environ["RTA_DB"] = args.db

    import uvicorn
    uvicorn.run("rta_server.app:create_app", factory=True, host=args.host, port=args.port, reload=args.reload,
                proxy_headers=True, forwarded_allow_ips=os.environ.get("FORWARDED_ALLOW_IPS", "127.0.0.1"))


if __name__ == "__main__":
    main()
