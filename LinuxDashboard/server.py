#!/usr/bin/env python3
"""Serve LinuxDashboard and proxy inventory from the Linux telemetry server."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LINUX_INVENTORY_URL = "http://10.16.210.13:5000/inventory"
PORT = 8080
ROOT = Path(__file__).resolve().parent


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/inventory":
            self._proxy_inventory()
            return
        super().do_GET()

    def _proxy_inventory(self) -> None:
        try:
            request = urllib.request.Request(
                LINUX_INVENTORY_URL,
                headers={"Accept": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                body = response.read()
                self.send_response(response.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as error:
            body = json.dumps(
                {"error": f"Linux server returned HTTP {error.code}"}
            ).encode()
            self.send_response(error.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as error:  # noqa: BLE001 - surface proxy failures to the UI
            body = json.dumps({"error": str(error)}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        print(f"[LinuxDashboard] {self.address_string()} - {format % args}")


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), DashboardHandler)
    print(f"LinuxDashboard running at http://localhost:{PORT}/")
    print(f"Proxying /inventory -> {LINUX_INVENTORY_URL}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
