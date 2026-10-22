#!/usr/bin/env python3
"""Serve the experiment trace UI and one evidence file on loopback only."""

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ASSETS = Path(__file__).with_name("trace-viewer")
ROUTES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/model.js": ("model.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8761)
    parser.add_argument(
        "--evidence", type=Path,
        default=Path(__file__).parent / "validation/latest.json",
    )
    args = parser.parse_args()
    evidence_path = args.evidence.resolve()
    evidence = json.loads(evidence_path.read_text())
    if evidence.get("experiment_id") != "1-1" or not evidence.get("arms"):
        parser.error("Expected an Experiment 1-1 evidence.json with arms")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/api/evidence":
                body = evidence_path.read_bytes()
                content_type = "application/json; charset=utf-8"
            elif path in ROUTES:
                name, content_type = ROUTES[path]
                body = (ASSETS / name).read_bytes()
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self'")
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Trace viewer: http://127.0.0.1:{args.port}", flush=True)
    print(f"Evidence: {evidence_path}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
