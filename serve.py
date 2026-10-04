#!/usr/bin/env python3
"""Serve only this site's static files on loopback. No upload/processing endpoint."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class StaticHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".wasm": "application/wasm",
        ".woff2": "font/woff2",
        ".json": "application/json; charset=utf-8",
    }

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "microphone=(self), camera=(), geolocation=()")
        self.send_header("Cache-Control", "no-cache")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
            "style-src 'self' 'unsafe-inline'; font-src 'self'; "
            "img-src 'self' data: blob:; media-src 'self' blob:; "
            "worker-src 'self' blob:; connect-src 'self' blob:; "
            "object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
        )
        super().end_headers()

    def list_directory(self, path):
        self.send_error(403, "Directory listing disabled")
        return None

    def log_message(self, fmt, *args):
        # File selections never reach this server; omit request-path logs too.
        pass


def main():
    parser = argparse.ArgumentParser(description="음원 변환 사이트의 로컬 정적 파일 서버")
    parser.add_argument("--port", type=int, default=8765, help="로컬 포트 (기본 8765)")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("포트는 1~65535 사이여야 합니다.")
    directory = Path(__file__).resolve().parent
    handler = partial(StaticHandler, directory=str(directory))
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        print(f"송쌤과학 음원 변환 스튜디오: http://127.0.0.1:{args.port}", flush=True)
        print("정적 실행 파일만 제공합니다. 사용자 음원은 이 서버로 전송하지 않습니다.", flush=True)
        print("종료: Ctrl+C", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\n서버를 종료했습니다.")


if __name__ == "__main__":
    main()
