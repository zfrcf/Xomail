# -*- coding: utf-8 -*-
"""Xomail Desktop — fenêtre native (pywebview) affichant l'interface web
« parfaite », pilotée par un serveur mail Python local.

    python main.py            (option --selftest : contrôle sans fenêtre)
"""

import sys

import webview

from server import start_server


def main():
    if "--selftest" in sys.argv:
        import providers  # noqa: F401
        import mail_client  # noqa: F401
        import gofile  # noqa: F401
        httpd, port = start_server()
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/index.html",
                                    timeout=5) as r:
            assert r.status == 200
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/mail/list_providers",
            data=b"{}", headers={"Content-Type": "application/json"})
        import json
        data = json.loads(urllib.request.urlopen(req, timeout=5).read())
        assert data["ok"] and len(data["providers"]) == 11
        print("SELFTEST OK")
        return

    _, port = start_server()
    webview.create_window(
        "Xomail",
        f"http://127.0.0.1:{port}/index.html",
        width=1240, height=800, min_size=(900, 600),
        background_color="#0d1117",
    )
    webview.start()


if __name__ == "__main__":
    main()
