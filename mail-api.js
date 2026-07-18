/*
 * Boîte Mail — moteur webmail (vraies connexions IMAP/SMTP).
 *
 * Le navigateur ne parle jamais directement aux serveurs mail : il appelle
 * /api/mail/<methode> ici. La session est un JETON CHIFFRÉ (AES-256-GCM)
 * gardé par le navigateur : le serveur ne stocke RIEN sur disque et peut
 * même redémarrer (ou tourner en serverless sur Vercel) — à la requête
 * suivante, il déchiffre le jeton et rouvre la connexion IMAP tout seul.
 *
 * Variable d'environnement MAIL_SECRET : clé de chiffrement des jetons.
 * OBLIGATOIRE en production (sur Vercel, chaque instance doit avoir la
 * même clé). En local, une clé de développement est utilisée par défaut.
 */
const express = require("express");
const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const { simpleParser } = require("mailparser");
const MailComposer = require("nodemailer/lib/mail-composer");
const crypto = require("crypto");

const router = express.Router();
router.use(express.json({ limit: "35mb" })); // pièces jointes en base64

const SESSION_TTL_MS = 30 * 60 * 1000;      // connexion IMAP gardée en mémoire
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;   // durée de vie du jeton chiffré
const MAX_ATTACH_MB = 25;

// ---------------------------------------------------------------------------
// Filet de sécurité : un pépin dans une bibliothèque (IDLE imapflow qui
// tombe, etc.) ne doit JAMAIS faire tomber tout le serveur.
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (err) => {
  console.error("[mail] rejet non géré :", (err && err.message) || err);
});
process.on("uncaughtException", (err) => {
  console.error("[mail] exception non gérée :", (err && err.message) || err);
});

// ---------------------------------------------------------------------------
// Jetons chiffrés (AES-256-GCM) : le navigateur garde le jeton, le serveur
// peut toujours reconstruire la session à partir de lui.
// ---------------------------------------------------------------------------
if (!process.env.MAIL_SECRET && (process.env.VERCEL || process.env.NODE_ENV === "production")) {
  console.warn("[mail] ⚠ MAIL_SECRET non défini : les sessions ne survivront pas "
    + "d'une instance à l'autre. Définis MAIL_SECRET dans les variables "
    + "d'environnement du déploiement.");
}
const KEY = crypto.createHash("sha256")
  .update(process.env.MAIL_SECRET || "cle-de-developpement-a-changer")
  .digest();

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify(obj)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString("base64url");
}

function openSealed(token) {
  try {
    const buf = Buffer.from(String(token || ""), "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat(
      [decipher.update(buf.subarray(28)), decipher.final()]).toString());
  } catch {
    return null;
  }
}

const sealConfig = (config) => seal({ config, exp: Date.now() + TOKEN_TTL_MS });

function openToken(token) {
  const obj = openSealed(token);
  return obj && obj.exp > Date.now() ? obj.config : null;
}

// ---------------------------------------------------------------------------
// Sessions en mémoire : token -> { imap, config, last } (simple cache — la
// vérité, c'est le jeton ; si l'entrée manque, on reconnecte).
// ---------------------------------------------------------------------------
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.last > SESSION_TTL_MS) {
      s.imap.logout().catch(() => {});
      sessions.delete(token);
    }
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// OAuth Google : « Se connecter avec Google » — le mot de passe habituel est
// saisi sur la page de Google, l'app ne reçoit qu'un jeton d'accès.
// ---------------------------------------------------------------------------
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

async function googleTokens(params) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error("Google OAuth : " + (data.error_description || data.error || res.status));
  }
  return data;
}

/** Access token valide pour une config OAuth (rafraîchi au besoin, mis en
 *  cache sur la session). */
async function getAccessToken(config, session) {
  if (!config.oauth) return null;
  if (session && session.access_token && session.access_expiry > Date.now() + 60000) {
    return session.access_token;
  }
  const data = await googleTokens({
    client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET,
    refresh_token: config.oauth.refresh_token, grant_type: "refresh_token",
  });
  if (session) {
    session.access_token = data.access_token;
    session.access_expiry = Date.now() + (data.expires_in || 3600) * 1000;
  }
  return data.access_token;
}

async function openImap(config, accessToken) {
  const imap = new ImapFlow({
    host: config.imap_host, port: Number(config.imap_port) || 993, secure: true,
    auth: config.oauth
      ? { user: config.email, accessToken }
      : { user: config.email, pass: config.password },
    logger: false,
  });
  // l'écouteur DOIT être posé avant connect() : un event "error" sans
  // écouteur (même pendant un échec d'authentification) crashe le process
  imap.on("error", (err) => {
    console.error("[mail] connexion IMAP perdue :", (err && err.message) || err);
  });
  await imap.connect();
  return imap;
}

async function ensureSession(req) {
  const token = req.get("X-Mail-Token") || "";
  let session = sessions.get(token);
  if (session) {
    session.last = Date.now();
    return session;
  }
  const config = openToken(token);
  if (!config) return null; // jeton absent, invalide ou expiré
  // reconnexion transparente (redémarrage du serveur, instance Vercel froide…)
  session = { config, last: Date.now(), folders: [] };
  const accessToken = await getAccessToken(config, session);
  session.imap = await openImap(config, accessToken);
  session.imap.on("close", () => sessions.delete(token));
  sessions.set(token, session);
  await listFolders(session); // repeupler les rôles de dossiers
  return session;
}

function dropSession(req) {
  const token = req.get("X-Mail-Token") || "";
  const session = sessions.get(token);
  if (session) {
    session.imap.logout().catch(() => {});
    sessions.delete(token);
  }
}

// ---------------------------------------------------------------------------
// Préréglages fournisseurs (miroir de providers.py de l'app de bureau)
// ---------------------------------------------------------------------------
const PROVIDERS = [
  { id: "gmail", name: "Gmail", imap_host: "imap.gmail.com", imap_port: 993,
    smtp_host: "smtp.gmail.com", smtp_port: 465, smtp_ssl: true,
    note: "Le plus simple : clique sur « Se connecter avec Google » ci-dessous (mot de passe habituel, sur la page de Google). Sinon, un « mot de passe d'application » est requis ici." },
  { id: "outlook", name: "Outlook / Hotmail", imap_host: "outlook.office365.com", imap_port: 993,
    smtp_host: "smtp-mail.outlook.com", smtp_port: 587, smtp_ssl: false,
    note: "Microsoft bloque parfois l'authentification par mot de passe simple ; activer IMAP dans les paramètres Outlook.com." },
  { id: "yahoo", name: "Yahoo Mail", imap_host: "imap.mail.yahoo.com", imap_port: 993,
    smtp_host: "smtp.mail.yahoo.com", smtp_port: 465, smtp_ssl: true,
    note: "Yahoo exige un mot de passe d'application (Sécurité du compte → Gérer les mots de passe d'application)." },
  { id: "icloud", name: "iCloud Mail", imap_host: "imap.mail.me.com", imap_port: 993,
    smtp_host: "smtp.mail.me.com", smtp_port: 587, smtp_ssl: false,
    note: "iCloud exige un mot de passe d'application (appleid.apple.com → Connexion et sécurité)." },
  { id: "orange", name: "Orange", imap_host: "imap.orange.fr", imap_port: 993,
    smtp_host: "smtp.orange.fr", smtp_port: 465, smtp_ssl: true, note: "" },
  { id: "free", name: "Free", imap_host: "imap.free.fr", imap_port: 993,
    smtp_host: "smtp.free.fr", smtp_port: 465, smtp_ssl: true,
    note: "Activer l'accès IMAP dans la console Free (Zimbra)." },
  { id: "sfr", name: "SFR", imap_host: "imap.sfr.fr", imap_port: 993,
    smtp_host: "smtp.sfr.fr", smtp_port: 465, smtp_ssl: true, note: "" },
  { id: "laposte", name: "La Poste", imap_host: "imap.laposte.net", imap_port: 993,
    smtp_host: "smtp.laposte.net", smtp_port: 465, smtp_ssl: true, note: "" },
  { id: "ovh", name: "OVH", imap_host: "ssl0.ovh.net", imap_port: 993,
    smtp_host: "ssl0.ovh.net", smtp_port: 465, smtp_ssl: true, note: "" },
  { id: "custom", name: "Personnalisé…", imap_host: "", imap_port: 993,
    smtp_host: "", smtp_port: 465, smtp_ssl: true,
    note: "Renseigne les serveurs IMAP et SMTP fournis par ton hébergeur." },
];

// ---------------------------------------------------------------------------
// Messages d'erreur compréhensibles
// ---------------------------------------------------------------------------
function friendly(error) {
  const msg = String((error && error.responseText) || (error && error.message) || error);
  if (/Application-specific password|application specific/i.test(msg)) {
    return "Google refuse le mot de passe habituel en IMAP. Utilise le bouton "
         + "« Se connecter avec Google » (mot de passe normal, sur la page "
         + "Google), ou crée un « mot de passe d'application ».";
  }
  if (/AUTHENTICATIONFAILED|AUTHENTICATE|Invalid credentials|LOGIN failed|authentication/i.test(msg)) {
    return "Identifiants refusés. Vérifie l'adresse et le mot de passe "
         + "(Gmail/Yahoo/iCloud exigent un mot de passe d'application).";
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return "Serveur mail introuvable — vérifie le nom du serveur.";
  if (/ETIMEDOUT|timeout/i.test(msg)) return "Le serveur mail ne répond pas (délai dépassé).";
  return msg;
}

// enveloppe commune : session + erreurs → {ok:...}
function handler(needsSession, fn) {
  return async (req, res) => {
    try {
      let session = null;
      if (needsSession) {
        session = await ensureSession(req);
        if (!session) {
          return res.json({ ok: false, session_expired: true,
                            error: "Session expirée — reconnecte-toi." });
        }
      }
      res.json(await fn(session, req.body || {}, req));
    } catch (error) {
      console.error("[mail]", (error && error.message) || error);
      // connexion IMAP tombée en plein vol : on jette le cache, le jeton du
      // navigateur permettra une reconnexion transparente au prochain appel
      if (/NoConnection|not connected|Connection closed|socket/i
          .test(String(error && error.message))) {
        dropSession(req);
        return res.json({ ok: false,
                          error: "Connexion au serveur mail perdue — réessaie." });
      }
      res.json({ ok: false, error: friendly(error) });
    }
  };
}

// ---------------------------------------------------------------------------
// Aides IMAP
// ---------------------------------------------------------------------------
const ROLE_BY_USE = { "\\Sent": "sent", "\\Trash": "trash", "\\Drafts": "drafts",
                      "\\Junk": "junk", "\\Archive": "archive", "\\All": "archive",
                      "\\Inbox": "inbox" };
const ROLE_BY_NAME = [
  ["sent", ["sent", "envoy"]], ["trash", ["trash", "corbeille", "deleted"]],
  ["drafts", ["draft", "brouillon"]], ["junk", ["junk", "spam", "courrier ind"]],
  ["archive", ["archive", "all mail", "tous les messages"]],
];

function roleFor(entry) {
  if (entry.path.toUpperCase() === "INBOX") return "inbox";
  const use = ROLE_BY_USE[entry.specialUse || ""];
  if (use) return use;
  const low = (entry.name || entry.path).toLowerCase();
  for (const [role, needles] of ROLE_BY_NAME) {
    if (needles.some((n) => low.includes(n))) return role;
  }
  return "";
}

async function listFolders(session) {
  const entries = await session.imap.list();
  const folders = [];
  for (const entry of entries) {
    if ((entry.flags && entry.flags.has("\\Noselect")) || entry.path === "") continue;
    folders.push({ raw: entry.path,
                   name: entry.path.toUpperCase() === "INBOX"
                     ? "Boîte de réception" : (entry.name || entry.path),
                   role: roleFor(entry), unseen: 0 });
  }
  folders.sort((a, b) => (a.raw.toUpperCase() !== "INBOX") - (b.raw.toUpperCase() !== "INBOX")
    || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  for (const f of folders.slice(0, 25)) {
    try {
      const st = await session.imap.status(f.raw, { unseen: true });
      f.unseen = st.unseen || 0;
    } catch { /* certains dossiers refusent STATUS */ }
  }
  session.folders = folders;
  return folders;
}

function specialFolder(session, role) {
  const f = (session.folders || []).find((x) => x.role === role);
  return f ? f.raw : null;
}

const FR_DATE = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });

function fmtDate(d) {
  try { return FR_DATE.format(d).replace(",", ""); } catch { return String(d || ""); }
}

async function fetchHeaders(session, folder, uids) {
  if (!uids.length) return [];
  const messages = [];
  const lock = await session.imap.getMailboxLock(folder);
  try {
    for await (const msg of session.imap.fetch(
        { uid: uids.join(",") }, { envelope: true, flags: true, uid: true },
        { uid: true })) {
      const env = msg.envelope || {};
      const from = (env.from && env.from[0]) || {};
      messages.push({
        uid: msg.uid,
        subject: env.subject || "(sans objet)",
        from_name: from.name || from.address || "",
        from_addr: from.address || "",
        date: fmtDate(env.date),
        seen: msg.flags.has("\\Seen"),
        answered: msg.flags.has("\\Answered"),
        flagged: msg.flags.has("\\Flagged"),
        message_id: env.messageId || "",
      });
    }
  } finally {
    lock.release();
  }
  messages.sort((a, b) => b.uid - a.uid);
  return messages;
}

async function searchUids(session, folder, query) {
  const lock = await session.imap.getMailboxLock(folder);
  try {
    return (await session.imap.search(query, { uid: true })) || [];
  } finally {
    lock.release();
  }
}

const SCRIPT_RE = /<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi;
const EVENT_RE = /\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function fetchFull(session, folder, uid) {
  const lock = await session.imap.getMailboxLock(folder);
  let raw;
  try {
    const dl = await session.imap.download(String(uid), undefined, { uid: true });
    const chunks = [];
    for await (const chunk of dl.content) chunks.push(chunk);
    raw = Buffer.concat(chunks);
  } finally {
    lock.release();
  }
  return simpleParser(raw);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
router.post("/list_providers", handler(false, async () =>
  ({ ok: true, providers: PROVIDERS })));

router.post("/connect", handler(false, async (_s, body) => {
  const config = body.config || {};
  if (!config.email || !config.imap_host || !config.password) {
    return { ok: false, error: "Adresse, serveur IMAP et mot de passe obligatoires." };
  }
  const imap = await openImap(config);
  const token = sealConfig(config);
  const session = { imap, config, last: Date.now(), folders: [] };
  imap.on("close", () => sessions.delete(token));
  sessions.set(token, session);
  const folders = await listFolders(session);
  return { ok: true, token, email: config.email, folders };
}));

router.post("/disconnect", handler(false, async (_s, _b, req) => {
  dropSession(req);
  return { ok: true };
}));

// --------------------------------------------------------------- OAuth Google

function baseUrl(req) {
  const host = req.get("host") || "";
  // APP_URL (ex. https://xomail.vercel.app) fixe l'URL publique pour OAuth —
  // ignorée en local pour que le retour Google revienne bien sur localhost
  if (process.env.APP_URL && !/^(localhost|127\.)/.test(host)) {
    return process.env.APP_URL.replace(/\/+$/, "");
  }
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  return `${proto}://${host}`;
}

router.get("/oauth/google/start", (req, res) => {
  if (!GOOGLE_ID || !GOOGLE_SECRET) {
    return res.redirect("/#oauth_error=" + encodeURIComponent(
      "Connexion Google non configurée sur ce serveur (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)."));
  }
  const url = GOOGLE_AUTH_URL + "?" + new URLSearchParams({
    client_id: GOOGLE_ID,
    redirect_uri: baseUrl(req) + "/api/mail/oauth/google/callback",
    response_type: "code",
    scope: "https://mail.google.com/ openid email",
    access_type: "offline",
    prompt: "consent",                    // garantit un refresh_token
    state: seal({ exp: Date.now() + 10 * 60 * 1000 }),
  });
  res.redirect(url);
});

router.get("/oauth/google/callback", async (req, res) => {
  const fail = (msg) => res.redirect("/#oauth_error=" + encodeURIComponent(msg));
  try {
    if (req.query.error) return fail("Google a refusé : " + req.query.error);
    const state = openSealed(req.query.state);
    if (!state || state.exp < Date.now()) return fail("Session OAuth expirée, réessaie.");
    const data = await googleTokens({
      code: String(req.query.code || ""),
      client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET,
      redirect_uri: baseUrl(req) + "/api/mail/oauth/google/callback",
      grant_type: "authorization_code",
    });
    if (!data.refresh_token) return fail("Google n'a pas fourni de jeton de rafraîchissement, réessaie.");
    const idPayload = JSON.parse(
      Buffer.from(String(data.id_token).split(".")[1], "base64url").toString());
    const email = idPayload.email;
    const config = {
      email, provider_id: "gmail",
      imap_host: "imap.gmail.com", imap_port: 993,
      smtp_host: "smtp.gmail.com", smtp_port: 465, smtp_ssl: true,
      oauth: { provider: "google", refresh_token: data.refresh_token },
    };
    // vérifier tout de suite que l'IMAP accepte le jeton
    const session = { config, last: Date.now(), folders: [],
                      access_token: data.access_token,
                      access_expiry: Date.now() + (data.expires_in || 3600) * 1000 };
    session.imap = await openImap(config, data.access_token);
    const token = sealConfig(config);
    session.imap.on("close", () => sessions.delete(token));
    sessions.set(token, session);
    await listFolders(session);
    // jeton transmis dans le fragment (#…) : jamais envoyé au serveur ni journalisé
    res.redirect("/#gm=" + encodeURIComponent(token) + "&em=" + encodeURIComponent(email));
  } catch (error) {
    console.error("[mail] OAuth Google :", (error && error.message) || error);
    fail(friendly(error));
  }
});

router.post("/list_folders", handler(true, async (session) =>
  ({ ok: true, folders: await listFolders(session) })));

router.post("/create_folder", handler(true, async (session, body) => {
  if (!String(body.name || "").trim()) return { ok: false, error: "Nom de dossier vide" };
  await session.imap.mailboxCreate(String(body.name).trim());
  return { ok: true, folders: await listFolders(session) };
}));

router.post("/rename_folder", handler(true, async (session, body) => {
  if (body.raw.toUpperCase() === "INBOX") {
    return { ok: false, error: "La boîte de réception ne peut pas être renommée" };
  }
  const sep = body.raw.includes("/") ? "/" : (body.raw.includes(".") ? "." : "");
  const prefix = sep && body.raw.includes(sep)
    ? body.raw.slice(0, body.raw.lastIndexOf(sep) + 1) : "";
  await session.imap.mailboxRename(body.raw, prefix + String(body.new_name).trim());
  return { ok: true, folders: await listFolders(session) };
}));

router.post("/delete_folder", handler(true, async (session, body) => {
  if (body.raw.toUpperCase() === "INBOX") {
    return { ok: false, error: "La boîte de réception ne peut pas être supprimée" };
  }
  await session.imap.mailboxDelete(body.raw);
  return { ok: true, folders: await listFolders(session) };
}));

router.post("/list_messages", handler(true, async (session, body) => {
  let uids = await searchUids(session, body.folder, { all: true });
  if (body.before_uid) uids = uids.filter((u) => u < Number(body.before_uid));
  const batch = uids.slice(-50);
  return { ok: true, messages: await fetchHeaders(session, body.folder, batch),
           has_more: uids.length > batch.length };
}));

router.post("/search_messages", handler(true, async (session, body) => {
  const q = String(body.query || "").trim();
  const uids = await searchUids(session, body.folder,
    { or: [{ from: q }, { subject: q }, { body: q }] });
  return { ok: true, messages: await fetchHeaders(session, body.folder, uids.slice(-50)),
           has_more: uids.length > 50 };
}));

router.post("/get_message", handler(true, async (session, body) => {
  const parsed = await fetchFull(session, body.folder, body.uid);
  let html = parsed.html
    || (parsed.textAsHtml
        ? parsed.textAsHtml
        : `<pre style="white-space:pre-wrap;font-family:inherit">${esc(parsed.text)}</pre>`);
  html = html.replace(SCRIPT_RE, "").replace(EVENT_RE, "");
  let flagged = false;
  const lock = await session.imap.getMailboxLock(body.folder);
  try {
    await session.imap.messageFlagsAdd({ uid: String(body.uid) }, ["\\Seen"], { uid: true });
    for await (const m of session.imap.fetch({ uid: String(body.uid) },
        { flags: true, uid: true }, { uid: true })) {
      flagged = m.flags.has("\\Flagged");
    }
  } finally {
    lock.release();
  }
  const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
  return { ok: true, message: {
    uid: Number(body.uid),
    subject: parsed.subject || "(sans objet)",
    from_name: from.name || from.address || "",
    from_addr: from.address || "",
    to: (parsed.to && parsed.to.text) || "",
    cc: (parsed.cc && parsed.cc.text) || "",
    date: parsed.date ? fmtDate(parsed.date) : "",
    message_id: parsed.messageId || "",
    html, flagged,
    attachments: (parsed.attachments || []).map((a) => (
      { name: a.filename || "sans-nom", size: a.size || (a.content ? a.content.length : 0) })),
  } };
}));

router.post("/get_attachment", handler(true, async (session, body) => {
  const parsed = await fetchFull(session, body.folder, body.uid);
  const att = (parsed.attachments || [])[Number(body.index)];
  if (!att) return { ok: false, error: "Pièce jointe introuvable" };
  return { ok: true, name: att.filename || "fichier",
           b64: att.content.toString("base64") };
}));

async function setFlag(session, folder, uid, flag, on) {
  const lock = await session.imap.getMailboxLock(folder);
  try {
    const method = on ? "messageFlagsAdd" : "messageFlagsRemove";
    await session.imap[method]({ uid: String(uid) }, [flag], { uid: true });
  } finally {
    lock.release();
  }
}

router.post("/set_read", handler(true, async (session, body) => {
  await setFlag(session, body.folder, body.uid, "\\Seen", !!body.on);
  return { ok: true };
}));

router.post("/set_star", handler(true, async (session, body) => {
  await setFlag(session, body.folder, body.uid, "\\Flagged", !!body.on);
  return { ok: true };
}));

async function moveTo(session, folder, uid, dest) {
  const lock = await session.imap.getMailboxLock(folder);
  try {
    await session.imap.messageMove({ uid: String(uid) }, dest, { uid: true });
  } finally {
    lock.release();
  }
}

router.post("/move_message", handler(true, async (session, body) => {
  await moveTo(session, body.folder, body.uid, body.dest);
  return { ok: true };
}));

router.post("/archive_message", handler(true, async (session, body) => {
  let dest = specialFolder(session, "archive");
  if (!dest) {
    await session.imap.mailboxCreate("Archive");
    await listFolders(session);
    dest = "Archive";
  }
  await moveTo(session, body.folder, body.uid, dest);
  return { ok: true };
}));

router.post("/delete_message", handler(true, async (session, body) => {
  const trash = specialFolder(session, "trash");
  if (trash && body.folder !== trash) {
    await moveTo(session, body.folder, body.uid, trash);
    return { ok: true, how: "trash" };
  }
  const lock = await session.imap.getMailboxLock(body.folder);
  try {
    await session.imap.messageDelete({ uid: String(body.uid) }, { uid: true });
  } finally {
    lock.release();
  }
  return { ok: true, how: "expunged" };
}));

// ---------------------------------------------------------------------------
// Pièces jointes → liens Gofile : les fichiers sont téléversés sur Gofile et
// le mail contient les liens de téléchargement (jamais de fichier en MIME —
// évite aussi les blocages Gmail sur les .exe/.zip).
// GOFILE_API_TOKEN (env) : jetons du compte Gofile ; sans jeton, l'envoi se
// fait en invité (compte guest créé par Gofile à la volée).
// ---------------------------------------------------------------------------
const GOFILE_TOKEN = process.env.GOFILE_API_TOKEN || "";

function fmtSize(bytes) {
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + " Mo";
  if (bytes > 1024) return Math.round(bytes / 1024) + " Ko";
  return bytes + " o";
}

async function uploadToGofile(name, content) {
  const form = new FormData();
  form.append("file", new Blob([content]), name || "fichier");
  const headers = {};
  if (GOFILE_TOKEN) headers.Authorization = "Bearer " + GOFILE_TOKEN;
  const res = await fetch("https://upload.gofile.io/uploadfile",
                          { method: "POST", headers, body: form });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.status !== "ok" || !data.data || !data.data.downloadPage) {
    throw new Error("Gofile : téléversement échoué ("
      + ((data && data.status) || res.status) + ")");
  }
  return data.data.downloadPage;
}

/** Téléverse chaque pièce jointe sur Gofile ; retourne le bloc de texte à
 *  ajouter au corps du mail (ou "" si aucune). */
async function attachmentsToLinks(list) {
  if (!list || !list.length) return "";
  const lines = [];
  for (const a of list) {
    const content = Buffer.from(a.b64 || "", "base64");
    if (content.length > MAX_ATTACH_MB * 1024 * 1024) {
      throw new Error(`Pièce jointe trop lourde (max ${MAX_ATTACH_MB} Mo) : ${a.name}`);
    }
    const link = await uploadToGofile(a.name, content);
    lines.push(`• ${a.name || "fichier"} (${fmtSize(content.length)}) : ${link}`);
  }
  return "\n\n— Pièces jointes (liens de téléchargement) —\n" + lines.join("\n");
}

router.post("/send_message", handler(true, async (session, body) => {
  if (!String(body.to || "").trim()) return { ok: false, error: "Destinataire manquant" };
  const config = session.config;
  const port = Number(config.smtp_port) || 465;
  const auth = config.oauth
    ? { type: "OAuth2", user: config.email,
        accessToken: await getAccessToken(config, session) }
    : { user: config.email, pass: config.password };
  const transport = nodemailer.createTransport({
    host: config.smtp_host, port,
    secure: config.smtp_ssl !== false && port !== 587,
    requireTLS: port === 587,
    auth,
    connectionTimeout: 30000,
  });
  // fichiers → liens Gofile ajoutés au corps ; aucun fichier joint en MIME
  const linksBlock = await attachmentsToLinks(body.attachments);
  const mail = {
    from: config.email, to: body.to, cc: body.cc || undefined,
    subject: body.subject || "", text: (body.body || "") + linksBlock,
    inReplyTo: body.in_reply_to || undefined,
    references: body.in_reply_to || undefined,
  };
  await transport.sendMail(mail);
  transport.close();
  // copie « envoyés » pour les serveurs qui ne la font pas (Gmail la fait seul)
  const sent = specialFolder(session, "sent");
  if (sent && !/gmail/.test(config.imap_host)) {
    try {
      const raw = await new MailComposer(mail).compile().build();
      await session.imap.append(sent, raw, ["\\Seen"]);
    } catch { /* l'envoi a réussi, la copie est du confort */ }
  }
  return { ok: true };
}));

router.post("/save_draft", handler(true, async (session, body) => {
  let drafts = specialFolder(session, "drafts");
  if (!drafts) {
    await session.imap.mailboxCreate("Brouillons");
    await listFolders(session);
    drafts = "Brouillons";
  }
  const raw = await new MailComposer({
    from: session.config.email, to: body.to || undefined,
    cc: body.cc || undefined, subject: body.subject || "",
    text: body.body || "",
  }).compile().build();
  await session.imap.append(drafts, raw, ["\\Draft", "\\Seen"]);
  const entry = (session.folders || []).find((f) => f.raw === drafts);
  return { ok: true, folder: entry ? entry.name : drafts };
}));

module.exports = router;
