"""Synthetic Cost Management HTTP responses for the notebook's restatement story.

Envelope and continuation shapes follow the Git-pinned worker's test/fake-cost.ts
(Query Farm, MIT). Ledger entries are invented; no Azure requests are forwarded.
"""

from __future__ import annotations

import json
import threading
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PATH = "/subscriptions/notebook-synthetic/providers/Microsoft.CostManagement/query"
COLUMNS = [
    {"name": "UsageDate", "type": "Number"},
    {"name": "ResourceGroup", "type": "String"},
    {"name": "Cost", "type": "Number"},
    {"name": "Currency", "type": "String"},
]


class SyntheticCostApi:
    """Serve two explicit ledger snapshots through a paged local HTTP endpoint."""

    def __init__(self) -> None:
        self.phase = 1
        self.requests: list[dict] = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:
                pass

            def do_POST(self) -> None:  # noqa: N802
                try:
                    length = int(self.headers.get("content-length", "0"))
                    body = json.loads(self.rfile.read(length))
                    payload = fixture.response(self.path, body)
                    status = 200
                except (ValueError, KeyError, TypeError) as error:
                    status, payload = 400, {"error": str(error)}
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_port}"

    def start(self) -> SyntheticCostApi:
        self._thread.start()
        return self

    def restate(self) -> None:
        """Publish a revised synthetic snapshot, not a request to any real service."""
        self.phase = 2

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)

    def response(self, path: str, body: dict) -> dict:
        parsed = urlparse(path)
        if parsed.path != PATH:
            raise ValueError("Only the notebook-synthetic cost query scope is supported")
        if body["type"] != "ActualCost" or body["dataset"]["granularity"] != "Daily":
            raise ValueError("This fixture supports Daily ActualCost only")
        if body["dataset"]["grouping"] != [{"type": "Dimension", "name": "ResourceGroup"}]:
            raise ValueError("This fixture supports only Dimension:ResourceGroup")
        start = date.fromisoformat(body["timePeriod"]["from"][:10])
        end = date.fromisoformat(body["timePeriod"]["to"][:10])
        if not date(2026, 6, 17) <= start <= end <= date(2026, 6, 30):
            raise ValueError("Synthetic coverage is 2026-06-17 through 2026-06-30, inclusive")
        self.requests.append({"path": path, "body": body, "phase": self.phase})
        rows = []
        # Days 17–23 have no ledger entries. Initial through-day-28 costs are
        # followed by two new days. Phase 2 revises compute on day 25 upward
        # by USD22 and removes the USD10 storage entry on day 26.
        for day, compute in zip(range(24, 31), [40, 50, 45, 55, 60, 65, 70], strict=True):
            if not start <= date(2026, 6, day) <= end:
                continue
            if self.phase == 2 and day == 25:
                compute = 72
            rows.append([20260600 + day, "rg-compute", compute, "USD"])
            if not (self.phase == 2 and day == 26):
                rows.append([20260600 + day, "rg-storage", 10, "USD"])
        offset = int(parse_qs(parsed.query).get("$skiptoken", ["0"])[0])
        page = rows[offset : offset + 3]
        properties = {"columns": COLUMNS, "rows": page}
        if offset + 3 < len(rows):
            properties["nextLink"] = (
                f"https://management.azure.com{PATH}?api-version=2023-03-01&$skiptoken={offset + 3}"
            )
        return {"properties": properties}
