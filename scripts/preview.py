"""致知前端本地预览：python scripts/preview.py [端口] [--no-open]

只起一个静态服务把 src/ 直接发给浏览器，用来快速看界面改动，
不用每次重新编译 exe。invoke 走不到 Tauri，后端相关按钮会提示
「Tauri 运行时未就绪」，这是预期：这里只看布局与交互。
"""
from __future__ import annotations

import functools
import http.server
import pathlib
import socketserver
import sys
import webbrowser

ROOT = pathlib.Path(__file__).resolve().parent.parent / "src"


def main() -> None:
    args = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    port = int(args[0]) if args else 8765
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        url = f"http://127.0.0.1:{port}/index.html"
        print(f"预览：{url}（Ctrl+C 停止）")
        if "--no-open" not in sys.argv:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
