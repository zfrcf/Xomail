# -*- coding: utf-8 -*-
"""Point d'entrée serveur-seul (sans fenêtre) — pour aperçu/tests navigateur."""
import time
from server import start_server
if __name__ == "__main__":
    _, port = start_server()
    print(f"Xomail server on http://127.0.0.1:{port}", flush=True)
    while True:
        time.sleep(3600)
