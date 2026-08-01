# -*- coding: utf-8 -*-
"""Téléversement de pièces jointes sur Gofile (sans dépendance externe).

Reproduit le comportement de la version web : chaque fichier est envoyé sur
Gofile et le mail contient le lien de téléchargement au lieu du fichier —
plus jamais de rejet Gmail 552 sur les .exe/.zip.
"""

import json
import os
import ssl
import urllib.request
import uuid

MAX_ATTACH_MB = 25
GOFILE_TOKEN = os.environ.get("GOFILE_API_TOKEN", "")


def _fmt_size(n):
    if n > 1048576:
        return f"{n / 1048576:.1f} Mo"
    if n > 1024:
        return f"{round(n / 1024)} Ko"
    return f"{n} o"


def _multipart(name, content):
    """Construit un corps multipart/form-data avec un seul champ « file »."""
    boundary = "----XomailBoundary" + uuid.uuid4().hex
    pre = (f'--{boundary}\r\n'
           f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
           f'Content-Type: application/octet-stream\r\n\r\n').encode("utf-8")
    post = f'\r\n--{boundary}--\r\n'.encode("utf-8")
    return boundary, pre + content + post


def upload(name, content):
    """Téléverse un fichier ; retourne l'URL de la page de téléchargement."""
    boundary, body = _multipart(name or "fichier", content)
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    if GOFILE_TOKEN:
        headers["Authorization"] = "Bearer " + GOFILE_TOKEN
    req = urllib.request.Request("https://upload.gofile.io/uploadfile",
                                 data=body, headers=headers, method="POST")
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data.get("status") != "ok" or not data.get("data", {}).get("downloadPage"):
        raise RuntimeError("Gofile : téléversement échoué (" + str(data.get("status")) + ")")
    return data["data"]["downloadPage"]


def attachments_to_links(attachments):
    """Prend [{name, b64}], téléverse chacun, retourne le bloc de texte à
    ajouter au corps du mail (ou '' si aucune pièce jointe)."""
    import base64
    if not attachments:
        return ""
    lines = []
    for a in attachments:
        content = base64.b64decode(a.get("b64", ""))
        if len(content) > MAX_ATTACH_MB * 1024 * 1024:
            raise RuntimeError(
                f"Pièce jointe trop lourde (max {MAX_ATTACH_MB} Mo) : {a.get('name')}")
        link = upload(a.get("name"), content)
        lines.append(f"• {a.get('name') or 'fichier'} ({_fmt_size(len(content))}) : {link}")
    return "\n\n— Pièces jointes (liens de téléchargement) —\n" + "\n".join(lines)
