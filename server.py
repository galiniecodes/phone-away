#!/usr/bin/env python3
"""Serve Phone Away's bundled browser-local detector on loopback only."""

import argparse
import json
import mimetypes
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import webbrowser

PUBLIC_DIR = Path(__file__).resolve().parent / "public"
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class PhoneAwayHandler(BaseHTTPRequestHandler):
    server_version = "PhoneAway/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, format, *args):
        # Avoid logging request paths or personal activity.
        pass

    def _headers(self, status, content_type, length):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        # The locally bundled ONNX/MediaPipe WASM runtimes need code compilation.
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def _json(self, status, value):
        raw = json.dumps(value, allow_nan=False).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(raw))
        if self.command != "HEAD":
            self.wfile.write(raw)

    def _check_host(self):
        hosts = self.headers.get_all("Host", [])
        port = self.server.server_port
        allowed = {"127.0.0.1:" + str(port), "localhost:" + str(port)}
        if port == 80:
            allowed.update(("127.0.0.1", "localhost"))
        if len(hosts) != 1 or hosts[0].lower() not in allowed:
            raise RequestError(403, "Open Phone Away using its localhost address.")
        return hosts[0].lower()

    def do_HEAD(self):
        self.do_GET(head_only=True)

    def do_GET(self, head_only=False):
        try:
            self._check_host()
            path = urlsplit(self.path).path
            if path.startswith("/api/"):
                raise RequestError(404, "This API endpoint does not exist.")
            decoded = unquote(path)
            if "\x00" in decoded or "\\" in decoded:
                raise RequestError(404, "File not found.")
            target = (PUBLIC_DIR / (decoded.lstrip("/") or "index.html")).resolve()
            try:
                target.relative_to(PUBLIC_DIR.resolve())
            except ValueError:
                raise RequestError(404, "File not found.")
            if not target.is_file():
                raise RequestError(404, "File not found.")
            raw = target.read_bytes()
            kind = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            self._headers(200, kind, len(raw))
            if not head_only:
                self.wfile.write(raw)
        except RequestError as error:
            self._json(error.status, {"error": str(error)})
        except OSError:
            self._json(500, {"error": "This file could not be read."})

    def do_POST(self):
        # All inference runs in the browser. Never accept camera uploads.
        try:
            self._check_host()
            self._json(405, {"error": "This server only serves local app files."})
        except RequestError as error:
            self._json(error.status, {"error": str(error)})


def make_server(port=8765):
    return ThreadingHTTPServer(("127.0.0.1", port), PhoneAwayHandler)


def main():
    parser = argparse.ArgumentParser(description="Run Phone Away locally on your Mac.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="Open the app in your default browser")
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    try:
        server = make_server(args.port)
    except OSError as error:
        parser.exit(1, "Could not start Phone Away: " + str(error) + "\nTry a different --port.\n")
    url = "http://127.0.0.1:" + str(server.server_port)
    print("Phone Away is running at " + url, flush=True)
    print("Camera frames are never saved by this server. Press Ctrl+C to stop.", flush=True)
    if args.open and not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
