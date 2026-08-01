# -*- coding: utf-8 -*-
"""Serveur HTTP local de Xomail Desktop.

Reproduit fidèlement le contrat de l'API du webmail (/api/mail/*) mais en
Python : l'interface web « parfaite » (web/) tourne telle quelle dans la
fenêtre pywebview et parle à ce serveur exactement comme elle parle au
serveur Node en ligne.

Endpoints POST /api/mail/<methode>  (corps et réponse JSON identiques au web).
OAuth Google : GET /api/mail/oauth/google/{start,callback,poll} — flux
« navigateur système + loopback » (les webviews embarqués sont bloqués par
Google).
"""

import base64
import json
import os
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import gofile
from mail_client import MailClient
from providers import PROVIDERS

# ---- OAuth Google (client « application de bureau », loopback autorisé) ----
# Le client_id est public ; le secret ne doit JAMAIS être versionné → il est
# lu uniquement depuis l'environnement (ou un fichier oauth.json local, ignoré
# par git). Sans secret, le bouton « Se connecter avec Google » affiche un
# message clair et l'utilisateur passe par un mot de passe d'application.
GOOGLE_CLIENT_ID = os.environ.get(
    "GOOGLE_CLIENT_ID",
    "982997348942-ivd5lp23i5bckfq9s2v7kt1t70b2lulb.apps.googleusercontent.com")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")

if not GOOGLE_CLIENT_SECRET:
    try:  # fichier local optionnel, non versionné
        with open(os.path.join(_base_dir_early := os.path.dirname(
                os.path.abspath(__file__)), "oauth.json"), encoding="utf-8") as _f:
            _oauth = json.load(_f)
            GOOGLE_CLIENT_ID = _oauth.get("client_id", GOOGLE_CLIENT_ID)
            GOOGLE_CLIENT_SECRET = _oauth.get("client_secret", "")
    except (OSError, ValueError):
        pass

_sessions = {}          # token -> MailClient
_oauth_pending = {}     # state -> {"result": None|{token,email}, "error": None}
_base_port = [0]        # port réel du serveur (rempli au démarrage)


def _base_dir():
    if getattr(sys, "frozen", False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


def _friendly(exc):
    msg = str(exc) or exc.__class__.__name__
    msg = msg.strip("b'\"")
    up = msg.upper()
    if "APPLICATION-SPECIFIC PASSWORD" in up or "APPLICATION SPECIFIC" in up:
        return ("Google refuse le mot de passe habituel en IMAP. Utilise le bouton "
                "« Se connecter avec Google », ou crée un « mot de passe d'application ».")
    if "AUTHENTICATIONFAILED" in up or "INVALID CREDENTIALS" in up or "AUTHENTICATE" in up:
        return ("Identifiants refusés. Vérifie l'adresse et le mot de passe "
                "(Gmail/Yahoo/iCloud exigent un mot de passe d'application).")
    if "GETADDRINFO" in up or "NAME OR SERVICE" in up:
        return "Serveur mail introuvable — vérifie le nom du serveur."
    return msg


# ------------------------------------------------------------ méthodes API

def _folders_of(client):
    return [{"raw": f["raw"], "name": f["name"], "role": f.get("role", ""),
             "unseen": f.get("unseen", 0)} for f in client.list_folders()]


def api_list_providers(_session, _body):
    return {"ok": True, "providers": PROVIDERS}


def api_connect(_session, body):
    config = body.get("config") or {}
    if not config.get("email") or not config.get("imap_host") or not config.get("password"):
        return {"ok": False, "error": "Adresse, serveur IMAP et mot de passe obligatoires."}
    client = MailClient()
    client.connect(config)
    token = uuid.uuid4().hex
    _sessions[token] = client
    return {"ok": True, "token": token, "email": config["email"],
            "folders": _folders_of(client)}


def api_disconnect(session, _body):
    return {"ok": True}  # la session est retirée par le routeur


def api_list_folders(session, _body):
    return {"ok": True, "folders": _folders_of(session)}


def api_create_folder(session, body):
    if not (body.get("name") or "").strip():
        return {"ok": False, "error": "Nom de dossier vide"}
    session.create_folder(body["name"].strip())
    return {"ok": True, "folders": _folders_of(session)}


def api_rename_folder(session, body):
    session.rename_folder(body["raw"], (body.get("new_name") or "").strip())
    return {"ok": True, "folders": _folders_of(session)}


def api_delete_folder(session, body):
    session.delete_folder(body["raw"])
    return {"ok": True, "folders": _folders_of(session)}


def api_list_messages(session, body):
    res = session.list_messages(body["folder"], limit=50,
                                before_uid=body.get("before_uid"))
    return {"ok": True, **res}


def api_search_messages(session, body):
    q = (body.get("query") or "").strip()
    if not q:
        return api_list_messages(session, body)
    res = session.search_messages(body["folder"], q)
    return {"ok": True, **res}


def api_get_message(session, body):
    return {"ok": True, "message": session.get_message(body["folder"], body["uid"])}


def api_get_attachment(session, body):
    name, payload = session.get_attachment(body["folder"], body["uid"],
                                           int(body["index"]))
    return {"ok": True, "name": name, "b64": base64.b64encode(payload).decode("ascii")}


def api_set_read(session, body):
    session.set_flag(body["folder"], body["uid"], "seen", bool(body.get("on")))
    return {"ok": True}


def api_set_star(session, body):
    session.set_flag(body["folder"], body["uid"], "flagged", bool(body.get("on")))
    return {"ok": True}


def api_move_message(session, body):
    session.move_message(body["folder"], body["uid"], body["dest"])
    return {"ok": True}


def api_archive_message(session, body):
    session.archive_message(body["folder"], body["uid"])
    return {"ok": True}


def api_delete_message(session, body):
    how = session.delete_message(body["folder"], body["uid"])
    return {"ok": True, "how": how}


def api_send_message(session, body):
    if not (body.get("to") or "").strip():
        return {"ok": False, "error": "Destinataire manquant"}
    # pièces jointes → liens Gofile ajoutés au corps (aucun fichier en MIME)
    links = gofile.attachments_to_links(body.get("attachments") or [])
    session.send_message(body["to"], body.get("subject", ""),
                         (body.get("body") or "") + links,
                         cc=body.get("cc", ""),
                         in_reply_to=body.get("in_reply_to", ""),
                         attachments=None)
    return {"ok": True}


def api_save_draft(session, body):
    folder = session.save_draft(body.get("to", ""), body.get("subject", ""),
                                body.get("body", ""), cc=body.get("cc", ""))
    return {"ok": True, "folder": folder}


API = {
    "list_providers": (False, api_list_providers),
    "connect": (False, api_connect),
    "disconnect": (True, api_disconnect),
    "list_folders": (True, api_list_folders),
    "create_folder": (True, api_create_folder),
    "rename_folder": (True, api_rename_folder),
    "delete_folder": (True, api_delete_folder),
    "list_messages": (True, api_list_messages),
    "search_messages": (True, api_search_messages),
    "get_message": (True, api_get_message),
    "get_attachment": (True, api_get_attachment),
    "set_read": (True, api_set_read),
    "set_star": (True, api_set_star),
    "move_message": (True, api_move_message),
    "archive_message": (True, api_archive_message),
    "delete_message": (True, api_delete_message),
    "send_message": (True, api_send_message),
    "save_draft": (True, api_save_draft),
}


# ------------------------------------------------------------ OAuth Google

def _redirect_uri():
    return f"http://localhost:{_base_port[0]}/api/mail/oauth/google/callback"


def _google_token_request(params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def oauth_start():
    """Ouvre la page Google dans le navigateur système, retourne une page
    d'attente (dans le webview) qui sonde la fin de la connexion."""
    if not GOOGLE_CLIENT_SECRET:
        return ("""<!doctype html><meta charset=utf-8><style>body{background:#0d1117;
color:#e6edf3;font-family:Segoe UI,sans-serif;text-align:center;padding-top:16vh}
a{color:#4f8ef7}</style><h2>🔑 Connexion Google non configurée</h2>
<p>Cette version n'embarque pas d'identifiants OAuth Google.<br>
Utilise un <b>mot de passe d'application</b> Gmail, ou configure
<code>GOOGLE_CLIENT_SECRET</code>.</p><p><a href="/">← Retour</a></p>""").encode("utf-8")
    state = uuid.uuid4().hex
    _oauth_pending[state] = {"result": None, "error": None}
    params = urllib.parse.urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "scope": "https://mail.google.com/ openid email",
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    })
    webbrowser.open("https://accounts.google.com/o/oauth2/v2/auth?" + params)
    return ("""<!doctype html><meta charset=utf-8>
<title>Connexion Google…</title>
<style>body{background:#0d1117;color:#e6edf3;font-family:Segoe UI,sans-serif;
text-align:center;padding-top:18vh}a{color:#4f8ef7}</style>
<h2>🔓 Connexion Google en cours…</h2>
<p>Une fenêtre de ton navigateur s'est ouverte pour te connecter à Google.<br>
Reviens ici une fois la connexion validée.</p>
<script>
const state=""" + json.dumps(state) + """;
setInterval(async()=>{
  const r=await fetch("/api/mail/oauth/google/poll?state="+state);
  const d=await r.json();
  if(d.token){location.href="/#gm="+encodeURIComponent(d.token)+"&em="+encodeURIComponent(d.email);}
  else if(d.error){document.body.innerHTML="<h2>❌ "+d.error+"</h2><p><a href='/'>Retour</a></p>";}
},1500);
</script>""").encode("utf-8")


def oauth_callback(query):
    """Reçu dans le NAVIGATEUR SYSTÈME après consentement Google."""
    state = query.get("state", [""])[0]
    pending = _oauth_pending.get(state)
    done = ("<!doctype html><meta charset=utf-8><style>body{background:#0d1117;"
            "color:#e6edf3;font-family:Segoe UI,sans-serif;text-align:center;"
            "padding-top:18vh}</style><h2>{msg}</h2>"
            "<p>Tu peux fermer cet onglet et revenir à Xomail.</p>")
    if not pending:
        return done.replace("{msg}", "Session OAuth expirée, réessaie.").encode("utf-8")
    try:
        if query.get("error"):
            raise RuntimeError("Google a refusé : " + query["error"][0])
        tokens = _google_token_request({
            "code": query.get("code", [""])[0],
            "client_id": GOOGLE_CLIENT_ID, "client_secret": GOOGLE_CLIENT_SECRET,
            "redirect_uri": _redirect_uri(), "grant_type": "authorization_code",
        })
        id_payload = json.loads(base64.urlsafe_b64decode(
            tokens["id_token"].split(".")[1] + "==").decode())
        email = id_payload["email"]
        config = {"email": email, "provider_id": "gmail",
                  "imap_host": "imap.gmail.com", "imap_port": 993,
                  "smtp_host": "smtp.gmail.com", "smtp_port": 465, "smtp_ssl": True,
                  "oauth": {"access_token": tokens["access_token"]}}
        client = MailClient()
        client.connect_oauth(email, tokens["access_token"])
        token = uuid.uuid4().hex
        _sessions[token] = client
        pending["result"] = {"token": token, "email": email}
        return done.replace("{msg}", "✅ Connecté ! ").encode("utf-8")
    except Exception as exc:
        traceback.print_exc()
        pending["error"] = _friendly(exc)
        return done.replace("{msg}", "❌ " + pending["error"]).encode("utf-8")


def oauth_poll(query):
    state = query.get("state", [""])[0]
    pending = _oauth_pending.get(state)
    if not pending:
        return {"error": "Session expirée"}
    if pending["result"]:
        res = pending["result"]
        _oauth_pending.pop(state, None)
        return res
    if pending["error"]:
        err = pending["error"]
        _oauth_pending.pop(state, None)
        return {"error": err}
    return {}


# ------------------------------------------------------------ serveur HTTP

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):  # silencieux
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- statique (interface web) ---
    def _serve_static(self, path):
        if path == "/" or not path:
            path = "/index.html"
        safe = os.path.normpath(path).lstrip("\\/")
        full = os.path.join(_base_dir(), "web", safe)
        if not full.startswith(os.path.join(_base_dir(), "web")) or not os.path.isfile(full):
            self._send(404, "Not found", "text/plain")
            return
        types = {".html": "text/html", ".css": "text/css",
                 ".js": "application/javascript", ".png": "image/png",
                 ".svg": "image/svg+xml", ".ico": "image/x-icon"}
        ctype = types.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype + ("; charset=utf-8" if "text" in ctype
                                               or "javascript" in ctype else ""))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, query = parsed.path, urllib.parse.parse_qs(parsed.query)
        if path == "/api/mail/oauth/google/start":
            self._send(200, oauth_start(), "text/html; charset=utf-8")
        elif path == "/api/mail/oauth/google/callback":
            self._send(200, oauth_callback(query), "text/html; charset=utf-8")
        elif path == "/api/mail/oauth/google/poll":
            self._send(200, oauth_poll(query))
        else:
            self._serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/mail/"):
            self._send(404, {"ok": False, "error": "Not found"})
            return
        method = parsed.path[len("/api/mail/"):]
        entry = API.get(method)
        if not entry:
            self._send(404, {"ok": False, "error": "Méthode inconnue"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            body = {}
        needs_session, fn = entry
        token = self.headers.get("X-Mail-Token", "")
        session = _sessions.get(token)
        if needs_session and session is None:
            self._send(200, {"ok": False, "session_expired": True,
                             "error": "Session expirée — reconnecte-toi."})
            return
        try:
            result = fn(session, body)
            if method == "disconnect":
                _sessions.pop(token, None)
            self._send(200, result)
        except Exception as exc:
            traceback.print_exc()
            self._send(200, {"ok": False, "error": _friendly(exc)})


def start_server():
    """Démarre le serveur sur un port local stable (pour que le stockage du
    navigateur — comptes, jetons — persiste entre deux lancements) ;
    retourne (httpd, port)."""
    httpd = None
    for port in (8771, 8772, 8773, 8774, 8775, 0):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if httpd is None:
        raise RuntimeError("Aucun port local disponible")
    _base_port[0] = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True,
                     name="xomail-http").start()
    return httpd, _base_port[0]
