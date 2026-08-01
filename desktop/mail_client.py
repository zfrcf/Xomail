# -*- coding: utf-8 -*-
"""Client IMAP/SMTP : connexion, dossiers, messages, recherche, envoi."""

import base64
import email
import email.header
import email.utils
import html
import imaplib
import mimetypes
import os
import re
import smtplib
import ssl
import threading
import time
from email.message import EmailMessage

imaplib._MAXLINE = 10_000_000  # certains serveurs renvoient de très longues lignes

HEADER_FIELDS = "(FROM TO SUBJECT DATE MESSAGE-ID AUTO-SUBMITTED PRECEDENCE)"


# ---------------------------------------------------------------- utf-7 IMAP

def imap_utf7_decode(s):
    """Décode un nom de dossier IMAP (UTF-7 modifié, RFC 3501)."""
    res, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "&":
            j = s.find("-", i)
            if j == -1:
                j = len(s)
            chunk = s[i + 1:j]
            if not chunk:
                res.append("&")
            else:
                b64 = chunk.replace(",", "/")
                b64 += "=" * ((4 - len(b64) % 4) % 4)
                try:
                    res.append(base64.b64decode(b64).decode("utf-16-be"))
                except Exception:
                    res.append(chunk)
            i = j + 1
        else:
            res.append(c)
            i += 1
    return "".join(res)


def imap_utf7_encode(s):
    """Encode un nom de dossier en UTF-7 modifié IMAP."""
    res, buf = [], []

    def flush():
        if buf:
            b64 = base64.b64encode("".join(buf).encode("utf-16-be")).decode("ascii")
            res.append("&" + b64.rstrip("=").replace("/", ",") + "-")
            buf.clear()

    for c in s:
        if 0x20 <= ord(c) <= 0x7E:
            flush()
            res.append("&-" if c == "&" else c)
        else:
            buf.append(c)
    flush()
    return "".join(res)


# ---------------------------------------------------------------- en-têtes

def decode_header_value(raw):
    """Décode un en-tête MIME (=?utf-8?...?=) en texte lisible."""
    if raw is None:
        return ""
    try:
        parts = email.header.decode_header(raw)
        out = []
        for data, charset in parts:
            if isinstance(data, bytes):
                out.append(data.decode(charset or "utf-8", errors="replace"))
            else:
                out.append(data)
        return "".join(out)
    except Exception:
        return str(raw)


def _part_text(part):
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def extract_body(msg):
    """Retourne (html, texte, pièces_jointes) d'un email.message.Message."""
    body_html, body_text, attachments = "", "", []
    for part in msg.walk():
        if part.is_multipart():
            continue
        filename = part.get_filename()
        disposition = str(part.get("Content-Disposition") or "")
        if filename or "attachment" in disposition:
            payload = part.get_payload(decode=True) or b""
            attachments.append({"name": decode_header_value(filename) or "sans-nom",
                                "size": len(payload)})
            continue
        ctype = part.get_content_type()
        if ctype == "text/html" and not body_html:
            body_html = _part_text(part)
        elif ctype == "text/plain" and not body_text:
            body_text = _part_text(part)
    return body_html, body_text, attachments


def extract_attachment(msg, index):
    """Retourne (nom, données) de la pièce jointe n° index (même ordre
    qu'extract_body)."""
    i = 0
    for part in msg.walk():
        if part.is_multipart():
            continue
        filename = part.get_filename()
        disposition = str(part.get("Content-Disposition") or "")
        if filename or "attachment" in disposition:
            if i == index:
                return (decode_header_value(filename) or "sans-nom",
                        part.get_payload(decode=True) or b"")
            i += 1
    raise RuntimeError("Pièce jointe introuvable")


_SCRIPT_RE = re.compile(r"<\s*script\b.*?<\s*/\s*script\s*>", re.I | re.S)
_EVENT_RE = re.compile(r"\son\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)


def sanitize_html(body):
    """Neutralise scripts et handlers inline (l'iframe est aussi sandboxée)."""
    body = _SCRIPT_RE.sub("", body)
    body = _EVENT_RE.sub("", body)
    return body


def text_to_html(text):
    return ("<pre style='white-space:pre-wrap;font-family:inherit'>"
            + html.escape(text) + "</pre>")


# ---------------------------------------------------------------- dossiers spéciaux

# rôle -> (drapeaux RFC 6154, morceaux de nom reconnus)
SPECIAL_FOLDERS = {
    "sent":    ((r"\sent",), ("sent", "envoy")),
    "trash":   ((r"\trash",), ("trash", "corbeille", "deleted")),
    "drafts":  ((r"\drafts",), ("draft", "brouillon")),
    "junk":    ((r"\junk",), ("junk", "spam", "courrier ind")),
    "archive": ((r"\archive", r"\all"), ("archive", "all mail", "tous les messages")),
}


# ---------------------------------------------------------------- client

class MailClient:
    """Connexion persistante à un compte (IMAP pour lire, SMTP pour envoyer)."""

    def __init__(self):
        self._imap = None
        self._config = None
        self._lock = threading.Lock()
        self._selected = None
        self._folders = []

    # ------------------------------------------------------------ connexion

    def connect(self, config):
        with self._lock:
            self._close_imap()
            imap = imaplib.IMAP4_SSL(config["imap_host"], int(config["imap_port"]),
                                     ssl_context=ssl.create_default_context())
            imap.login(config["email"], config["password"])
            self._imap = imap
            self._config = dict(config)
            self._selected = None

    def connect_oauth(self, email, access_token):
        """Connexion Gmail via jeton OAuth (XOAUTH2), sans mot de passe."""
        with self._lock:
            self._close_imap()
            imap = imaplib.IMAP4_SSL("imap.gmail.com", 993,
                                     ssl_context=ssl.create_default_context())
            auth = f"user={email}\x01auth=Bearer {access_token}\x01\x01"
            imap.authenticate("XOAUTH2", lambda _: auth.encode())
            self._imap = imap
            self._config = {"email": email,
                            "smtp_host": "smtp.gmail.com", "smtp_port": 465,
                            "smtp_ssl": True, "imap_host": "imap.gmail.com",
                            "imap_port": 993, "oauth_token": access_token}
            self._selected = None

    def disconnect(self):
        with self._lock:
            self._close_imap()
            self._config = None

    @property
    def connected(self):
        return self._imap is not None

    @property
    def email_address(self):
        return (self._config or {}).get("email", "")

    def _close_imap(self):
        if self._imap is not None:
            try:
                self._imap.logout()
            except Exception:
                pass
            self._imap = None
            self._selected = None

    def _ensure(self):
        if self._imap is None:
            raise RuntimeError("Non connecté")
        try:
            self._imap.noop()
        except Exception:
            # connexion tombée : on retente une fois
            config = self._config
            self._imap = None
            imap = imaplib.IMAP4_SSL(config["imap_host"], int(config["imap_port"]),
                                     ssl_context=ssl.create_default_context())
            imap.login(config["email"], config["password"])
            self._imap = imap
            self._selected = None

    # ------------------------------------------------------------ dossiers

    _LIST_RE = re.compile(
        rb'\((?P<flags>[^)]*)\)\s+(?:"(?P<delim>[^"]*)"|(?P<delim2>\S+))\s+(?P<name>.+)')

    def list_folders(self, with_unseen=True):
        with self._lock:
            self._ensure()
            typ, data = self._imap.list()
            if typ != "OK":
                raise RuntimeError("Impossible de lister les dossiers")
            folders = []
            for line in data:
                if isinstance(line, tuple):  # nom envoyé en littéral
                    line = line[0] + b' "' + line[1] + b'"'
                if not line:
                    continue
                m = self._LIST_RE.match(line)
                if not m:
                    continue
                flags = m.group("flags").decode("ascii", "replace").lower()
                if "\\noselect" in flags:
                    continue
                raw = m.group("name").decode("ascii", "replace").strip()
                if raw.startswith('"') and raw.endswith('"'):
                    raw = raw[1:-1]
                display = imap_utf7_decode(raw)
                folders.append({"raw": raw, "name": display, "flags": flags,
                                "role": self._role_for(flags, display)})
            # INBOX d'abord, puis alphabétique
            folders.sort(key=lambda f: (f["raw"].upper() != "INBOX", f["name"].lower()))
            for f in folders:
                if f["raw"].upper() == "INBOX":
                    f["name"] = "Boîte de réception"
                    f["role"] = "inbox"
            if with_unseen:
                for f in folders[:25]:  # borne : éviter 200 STATUS sur gros comptes
                    f["unseen"] = self._unseen_count(f["raw"])
            self._folders = folders
            return folders

    @staticmethod
    def _role_for(flags, display):
        low = display.lower()
        for role, (role_flags, needles) in SPECIAL_FOLDERS.items():
            if any(rf in flags for rf in role_flags):
                return role
        for role, (role_flags, needles) in SPECIAL_FOLDERS.items():
            if any(n in low for n in needles):
                return role
        return ""

    def _unseen_count(self, raw):
        try:
            typ, data = self._imap.status(f'"{raw}"', "(UNSEEN)")
            if typ == "OK" and data and data[0]:
                m = re.search(rb"UNSEEN (\d+)", data[0])
                if m:
                    return int(m.group(1))
        except Exception:
            pass
        return 0

    def special_folder(self, role):
        """Nom brut du dossier jouant ce rôle (sent/trash/drafts/junk/archive),
        ou None."""
        for f in self._folders:
            if f.get("role") == role:
                return f["raw"]
        return None

    def create_folder(self, name):
        with self._lock:
            self._ensure()
            raw = imap_utf7_encode(name)
            typ, data = self._imap.create(f'"{raw}"')
            if typ != "OK":
                raise RuntimeError("Création refusée : "
                                   + (data[0] or b"?").decode("ascii", "replace"))
            return raw

    def rename_folder(self, old_raw, new_name):
        if old_raw.upper() == "INBOX":
            raise RuntimeError("La boîte de réception ne peut pas être renommée")
        with self._lock:
            self._ensure()
            # conserver le préfixe parent ([Gmail]/… par ex.)
            sep = "/" if "/" in old_raw else ("." if "." in old_raw else "")
            prefix = old_raw.rsplit(sep, 1)[0] + sep if sep and sep in old_raw else ""
            new_raw = prefix + imap_utf7_encode(new_name)
            typ, data = self._imap.rename(f'"{old_raw}"', f'"{new_raw}"')
            if typ != "OK":
                raise RuntimeError("Renommage refusé : "
                                   + (data[0] or b"?").decode("ascii", "replace"))
            return new_raw

    def delete_folder(self, raw):
        if raw.upper() == "INBOX":
            raise RuntimeError("La boîte de réception ne peut pas être supprimée")
        with self._lock:
            self._ensure()
            self._selected = None
            typ, data = self._imap.delete(f'"{raw}"')
            if typ != "OK":
                raise RuntimeError("Suppression refusée : "
                                   + (data[0] or b"?").decode("ascii", "replace"))

    def _select(self, folder_raw, readonly=True):
        typ, data = self._imap.select(f'"{folder_raw}"', readonly=readonly)
        if typ != "OK":
            raise RuntimeError(f"Dossier introuvable : {imap_utf7_decode(folder_raw)}")
        self._selected = folder_raw
        return int(data[0])

    # ------------------------------------------------------------ messages

    _UID_RE = re.compile(rb"UID (\d+)")
    _FLAGS_RE = re.compile(rb"FLAGS \(([^)]*)\)")

    def _fetch_headers(self, uids):
        """En-têtes résumés pour une liste d'UID (dossier déjà sélectionné)."""
        if not uids:
            return []
        uid_set = b",".join(uids).decode("ascii")
        typ, data = self._imap.uid(
            "fetch", uid_set, f"(FLAGS BODY.PEEK[HEADER.FIELDS {HEADER_FIELDS}])")
        if typ != "OK":
            raise RuntimeError("Lecture des en-têtes impossible")
        messages = []
        for item in data:
            if not isinstance(item, tuple):
                continue
            meta, header_bytes = item[0], item[1]
            m_uid = self._UID_RE.search(meta)
            if not m_uid:
                continue
            m_flags = self._FLAGS_RE.search(meta)
            flags = m_flags.group(1).decode("ascii", "replace") if m_flags else ""
            msg = email.message_from_bytes(header_bytes)
            try:
                dt = email.utils.parsedate_to_datetime(msg.get("Date"))
                date_str = dt.astimezone().strftime("%d/%m/%Y %H:%M")
            except Exception:
                date_str = decode_header_value(msg.get("Date"))
            name, addr = email.utils.parseaddr(msg.get("From", ""))
            auto = (msg.get("Auto-Submitted", "no").lower() != "no"
                    or msg.get("Precedence", "").lower() in ("bulk", "list", "junk"))
            messages.append({
                "uid": int(m_uid.group(1)),
                "subject": decode_header_value(msg.get("Subject")) or "(sans objet)",
                "from_name": decode_header_value(name) or addr,
                "from_addr": addr,
                "date": date_str,
                "seen": "\\Seen" in flags,
                "answered": "\\Answered" in flags,
                "flagged": "\\Flagged" in flags,
                "message_id": msg.get("Message-ID", ""),
                "auto": auto,
            })
        messages.sort(key=lambda m: m["uid"], reverse=True)
        return messages

    def list_messages(self, folder_raw, limit=50, before_uid=None):
        """Les `limit` derniers messages (ou avant `before_uid` pour paginer)."""
        with self._lock:
            self._ensure()
            self._select(folder_raw, readonly=True)
            typ, data = self._imap.uid("search", None, "ALL")
            if typ != "OK":
                raise RuntimeError("Recherche impossible dans ce dossier")
            uids = data[0].split() if data and data[0] else []
            if before_uid:
                uids = [u for u in uids if int(u) < int(before_uid)]
            total_left = len(uids)
            batch = uids[-limit:]
            messages = self._fetch_headers(batch)
            return {"messages": messages, "has_more": total_left > len(batch)}

    def search_messages(self, folder_raw, query, limit=50):
        """Recherche serveur (expéditeur, objet, texte)."""
        with self._lock:
            self._ensure()
            self._select(folder_raw, readonly=True)
            try:
                query.encode("ascii")
                q = query.replace('"', "")
                typ, data = self._imap.uid(
                    "search", None, f'(OR OR FROM "{q}" SUBJECT "{q}" TEXT "{q}")')
            except UnicodeEncodeError:
                # non-ASCII : littéral UTF-8 sur TEXT
                self._imap.literal = query.encode("utf-8")
                typ, data = self._imap.uid("search", "CHARSET", "UTF-8", "TEXT")
            if typ != "OK":
                raise RuntimeError("Recherche refusée par le serveur")
            uids = data[0].split() if data and data[0] else []
            return {"messages": self._fetch_headers(uids[-limit:]),
                    "has_more": len(uids) > limit}

    def unseen_headers(self, folder_raw="INBOX"):
        """En-têtes des messages non lus (pour la réponse automatique)."""
        with self._lock:
            self._ensure()
            self._select(folder_raw, readonly=True)
            typ, data = self._imap.uid("search", None, "UNSEEN")
            if typ != "OK":
                return []
            uids = data[0].split() if data and data[0] else []
            return self._fetch_headers(uids[-50:])

    def get_message(self, folder_raw, uid, mark_seen=True):
        """Contenu complet d'un message ; le marque comme lu par défaut."""
        with self._lock:
            self._ensure()
            self._select(folder_raw, readonly=not mark_seen)
            typ, data = self._imap.uid("fetch", str(uid), "(FLAGS RFC822)")
            if typ != "OK" or not data or not isinstance(data[0], tuple):
                raise RuntimeError("Message introuvable")
            flags = b" ".join(d[0] if isinstance(d, tuple) else d for d in data)
            m_flags = self._FLAGS_RE.search(flags)
            flag_str = m_flags.group(1).decode("ascii", "replace") if m_flags else ""
            msg = email.message_from_bytes(data[0][1])
            body_html, body_text, attachments = extract_body(msg)
            if not body_html:
                body_html = text_to_html(body_text)
            name, addr = email.utils.parseaddr(msg.get("From", ""))
            return {
                "uid": int(uid),
                "subject": decode_header_value(msg.get("Subject")) or "(sans objet)",
                "from_name": decode_header_value(name) or addr,
                "from_addr": addr,
                "to": decode_header_value(msg.get("To")),
                "cc": decode_header_value(msg.get("Cc")),
                "date": decode_header_value(msg.get("Date")),
                "message_id": msg.get("Message-ID", ""),
                "html": sanitize_html(body_html),
                "flagged": "\\Flagged" in flag_str,
                "attachments": attachments,
            }

    def get_attachment(self, folder_raw, uid, index):
        """(nom, octets) de la pièce jointe n° index."""
        with self._lock:
            self._ensure()
            self._select(folder_raw, readonly=True)
            typ, data = self._imap.uid("fetch", str(uid), "(BODY.PEEK[])")
            if typ != "OK" or not data or not isinstance(data[0], tuple):
                raise RuntimeError("Message introuvable")
            msg = email.message_from_bytes(data[0][1])
            return extract_attachment(msg, int(index))

    # ------------------------------------------------------------ drapeaux / déplacement

    def set_flag(self, folder_raw, uid, flag, on):
        """flag: 'seen' ou 'flagged'."""
        imap_flag = {"seen": r"(\Seen)", "flagged": r"(\Flagged)"}[flag]
        with self._lock:
            self._ensure()
            self._select(folder_raw, readonly=False)
            self._imap.uid("store", str(uid), "+FLAGS" if on else "-FLAGS", imap_flag)

    def move_message(self, folder_raw, uid, dest_raw):
        if folder_raw == dest_raw:
            return
        with self._lock:
            self._ensure()
            self._select(folder_raw, readonly=False)
            typ, data = self._imap.uid("copy", str(uid), f'"{dest_raw}"')
            if typ != "OK":
                raise RuntimeError("Déplacement refusé : "
                                   + (data[0] or b"?").decode("ascii", "replace"))
            self._imap.uid("store", str(uid), "+FLAGS", r"(\Deleted)")
            self._imap.expunge()

    def delete_message(self, folder_raw, uid):
        """Vers la corbeille si elle existe et qu'on n'y est pas déjà,
        sinon suppression définitive. Retourne 'trash' ou 'expunged'."""
        trash = self.special_folder("trash")
        if trash and folder_raw != trash:
            self.move_message(folder_raw, uid, trash)
            return "trash"
        with self._lock:
            self._ensure()
            self._select(folder_raw, readonly=False)
            self._imap.uid("store", str(uid), "+FLAGS", r"(\Deleted)")
            self._imap.expunge()
            return "expunged"

    def archive_message(self, folder_raw, uid):
        """Vers le dossier archive (créé au besoin)."""
        dest = self.special_folder("archive")
        if dest is None:
            dest = self.create_folder("Archive")
            self._folders.append({"raw": dest, "name": "Archive",
                                  "flags": "", "role": "archive"})
        self.move_message(folder_raw, uid, dest)

    # ------------------------------------------------------------ écriture

    @staticmethod
    def _build_message(sender, to, subject, body, cc="", in_reply_to="",
                       attachments=None, auto_submitted=False):
        msg = EmailMessage()
        msg["From"] = sender
        msg["To"] = to
        if cc:
            msg["Cc"] = cc
        msg["Subject"] = subject
        msg["Date"] = email.utils.formatdate(localtime=True)
        msg["Message-ID"] = email.utils.make_msgid()
        if in_reply_to:
            msg["In-Reply-To"] = in_reply_to
            msg["References"] = in_reply_to
        if auto_submitted:
            msg["Auto-Submitted"] = "auto-replied"
            msg["X-Auto-Response-Suppress"] = "All"
        msg.set_content(body)
        for path in attachments or []:
            ctype, _ = mimetypes.guess_type(path)
            maintype, _, subtype = (ctype or "application/octet-stream").partition("/")
            with open(path, "rb") as f:
                msg.add_attachment(f.read(), maintype=maintype, subtype=subtype,
                                   filename=os.path.basename(path))
        return msg

    def _append(self, folder_raw, msg, flags=r"(\Seen)"):
        self._imap.append(f'"{folder_raw}"', flags,
                          imaplib.Time2Internaldate(time.time()), msg.as_bytes())

    def send_message(self, to, subject, body, cc="", in_reply_to="",
                     attachments=None, auto_submitted=False, copy_to_sent=True):
        if self._config is None:
            raise RuntimeError("Non connecté")
        config = self._config
        msg = self._build_message(config["email"], to, subject, body, cc=cc,
                                  in_reply_to=in_reply_to, attachments=attachments,
                                  auto_submitted=auto_submitted)
        host, port = config["smtp_host"], int(config["smtp_port"])
        context = ssl.create_default_context()
        if config.get("smtp_ssl", port == 465):
            server = smtplib.SMTP_SSL(host, port, context=context, timeout=30)
        else:
            server = smtplib.SMTP(host, port, timeout=30)
            server.starttls(context=context)
        try:
            if config.get("oauth_token"):
                auth = (f"user={config['email']}\x01"
                        f"auth=Bearer {config['oauth_token']}\x01\x01")
                server.ehlo()
                server.docmd("AUTH", "XOAUTH2 "
                             + base64.b64encode(auth.encode()).decode())
            else:
                server.login(config["email"], config["password"])
            server.send_message(msg)
        finally:
            server.quit()
        if copy_to_sent:
            # copie « Messages envoyés » (Gmail la fait déjà tout seul)
            sent = self.special_folder("sent")
            if sent and "gmail" not in config.get("imap_host", ""):
                try:
                    with self._lock:
                        self._ensure()
                        self._append(sent, msg)
                except Exception:
                    pass  # l'envoi a réussi, la copie est du confort

    def save_draft(self, to, subject, body, cc=""):
        """Enregistre un brouillon côté serveur. Retourne le dossier utilisé."""
        if self._config is None:
            raise RuntimeError("Non connecté")
        drafts = self.special_folder("drafts")
        if drafts is None:
            drafts = self.create_folder("Brouillons")
            self._folders.append({"raw": drafts, "name": "Brouillons",
                                  "flags": "", "role": "drafts"})
        msg = self._build_message(self._config["email"], to, subject, body, cc=cc)
        with self._lock:
            self._ensure()
            self._append(drafts, msg, flags=r"(\Draft \Seen)")
        return imap_utf7_decode(drafts)
