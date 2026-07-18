/* Boîte Mail (version site) — logique de l'interface.
   Toute la partie mail passe par le serveur du site (/api/mail/...), qui
   maintient la vraie connexion IMAP et envoie via SMTP. */

"use strict";

const $ = (id) => document.getElementById(id);

let FOLDERS = [];
let currentFolder = null;   // {raw, name}
let currentMessage = null;  // message ouvert
let lastListUid = null;     // pagination
let replyTo = null;         // Message-ID de réponse
let composeAttachments = []; // [{path,name,size}]
let searchMode = false;
let ctxFolder = null;       // dossier visé par le menu contextuel
let online = false;         // connecté au serveur (sinon : cache local)

/* ------------------------------------------------------------- pont serveur */

let TOKEN = "";

const LS_ACCOUNTS = "xm_accounts"; // [{email, provider_id, imap…, password_b64?, google_oauth?}]
const LS_ACTIVE = "xm_active";     // e-mail du compte actif
const LS_SETTINGS = "bm_settings"; // signature
const SS_TOKENS = "xm_tokens";     // jetons de session par compte (sessionStorage)

let activeEmail = localStorage.getItem(LS_ACTIVE) || "";

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); }
  catch { return null; }
}
function lsSet(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

/* ----- comptes ----- */

function accounts() { return lsGet(LS_ACCOUNTS) || []; }

function getAccount(email) { return accounts().find((a) => a.email === email); }

function upsertAccount(entry) {
  const list = accounts();
  const i = list.findIndex((a) => a.email === entry.email);
  if (i >= 0) list[i] = { ...list[i], ...entry };
  else list.push(entry);
  lsSet(LS_ACCOUNTS, list);
}

function removeAccount(email) {
  lsSet(LS_ACCOUNTS, accounts().filter((a) => a.email !== email));
}

function setActive(email) {
  activeEmail = email;
  localStorage.setItem(LS_ACTIVE, email);
}

/* ----- jetons de session (un par compte, le temps de l'onglet) ----- */

function tokens() {
  try { return JSON.parse(sessionStorage.getItem(SS_TOKENS) || "{}"); }
  catch { return {}; }
}

function setTokenFor(email, token) {
  const t = tokens();
  if (token) t[email] = token; else delete t[email];
  sessionStorage.setItem(SS_TOKENS, JSON.stringify(t));
  TOKEN = token || "";
}

/* migration depuis l'ancien format mono-compte */
(function migrate() {
  const old = lsGet("bm_config");
  if (old && old.email && !getAccount(old.email)) {
    upsertAccount(old);
    if (!activeEmail) setActive(old.email);
  }
  localStorage.removeItem("bm_config");
  const oldTok = sessionStorage.getItem("bm_token");
  if (oldTok && activeEmail) setTokenFor(activeEmail, oldTok);
  sessionStorage.removeItem("bm_token");
})();

function sessionExpired() {
  if (activeEmail) setTokenFor(activeEmail, "");
  TOKEN = "";
  setOnline(false);
  hide($("main-screen"));
  show($("login-screen"));
  const acc = getAccount(activeEmail);
  if (acc) prefillLogin(acc);
}

async function rpc(method, payload) {
  let res;
  try {
    res = await fetch("/api/mail/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Mail-Token": TOKEN },
      body: JSON.stringify(payload || {}),
    });
  } catch (e) {
    return { ok: false, error: "Serveur du site injoignable." };
  }
  if (!res.ok) return { ok: false, error: "Erreur serveur (" + res.status + ")" };
  const data = await res.json();
  if (data && data.session_expired) sessionExpired();
  return data;
}

/* méthodes servies localement (pas de cache hors ligne ni répondeur sur le web) */
const LOCAL = {
  open_offline: async () => ({ ok: false, error: "Pas de mode hors ligne sur le web" }),
  reconnect: async () => {
    const acc = getAccount(activeEmail);
    if (!acc || !acc.password_b64) {
      return { ok: false, error: "Pas de mot de passe enregistré" };
    }
    return LOCAL.connect({ ...acc }, true, true);
  },
  is_online: async () => ({ ok: true, online }),
  connect: async (config, remember, useSaved) => {
    const stored = getAccount(config.email);
    if ((useSaved || !config.password) && stored && stored.password_b64) {
      config = { ...config, password: atob(stored.password_b64) };
    }
    const res = await rpc("connect", { config });
    if (res.ok) {
      const keep = { ...config };
      delete keep.password;
      delete keep.password_b64;
      if (remember && config.password) keep.password_b64 = btoa(config.password);
      else if (stored && stored.password_b64) keep.password_b64 = stored.password_b64;
      upsertAccount(keep);
      setActive(config.email);
      setTokenFor(config.email, res.token);
    }
    return res;
  },
  disconnect: async (forget) => {
    await rpc("disconnect", {});
    if (activeEmail) setTokenFor(activeEmail, "");
    TOKEN = "";
    if (forget && activeEmail) removeAccount(activeEmail);
    return { ok: true };
  },
  get_settings: async () => {
    const s = lsGet(LS_SETTINGS) || {};
    return { ok: true, settings: {
      signature: s.signature || "",
      autoreply: { enabled: false, subject: "",
                   body: "Le répondeur automatique tourne dans l'application de bureau." } } };
  },
  save_settings: async (settings) => {
    lsSet(LS_SETTINGS, { signature: (settings && settings.signature) || "" });
    return { ok: true };
  },
  pick_attachments: async () => new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      const files = [];
      for (const f of input.files) {
        if (f.size > MAX_DROP_MB * 1024 * 1024) {
          toast(`Trop lourd (max ${MAX_DROP_MB} Mo) : ${f.name}`, "err");
          continue;
        }
        files.push({ name: f.name, size: f.size, b64: await fileToB64(f) });
      }
      resolve({ ok: true, files });
    };
    input.oncancel = () => resolve({ ok: true, files: [] });
    input.click();
  }),
  save_attachment: async (folder, uid, index) => {
    const res = await rpc("get_attachment", { folder, uid, index });
    if (!res.ok) return res;
    const bytes = Uint8Array.from(atob(res.b64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement("a");
    a.href = url;
    a.download = res.name;
    a.click();
    URL.revokeObjectURL(url);
    return { ok: true, saved: res.name };
  },
};

/* signature ajoutée côté navigateur avant l'envoi */
function withSignature(body) {
  const s = ((lsGet(LS_SETTINGS) || {}).signature || "").trim();
  return s ? body.replace(/\s+$/, "") + "\n\n-- \n" + s : body;
}

const ARG_NAMES = {
  list_providers: [],
  list_folders: [],
  create_folder: ["name"],
  rename_folder: ["raw", "new_name"],
  delete_folder: ["raw"],
  list_messages: ["folder", "before_uid"],
  search_messages: ["folder", "query"],
  get_message: ["folder", "uid"],
  set_read: ["folder", "uid", "on"],
  set_star: ["folder", "uid", "on"],
  move_message: ["folder", "uid", "dest"],
  archive_message: ["folder", "uid"],
  delete_message: ["folder", "uid"],
  send_message: ["to", "subject", "body", "cc", "in_reply_to", "attachments"],
  save_draft: ["to", "subject", "body", "cc"],
};

async function call(method, ...args) {
  try {
    if (LOCAL[method]) return await LOCAL[method](...args);
    const payload = {};
    (ARG_NAMES[method] || []).forEach((n, i) => { payload[n] = args[i]; });
    if (method === "send_message") payload.body = withSignature(payload.body || "");
    return await rpc(method, payload);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/* ---------------------------------------------------------------- helpers */

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function busy(on) { on ? show($("busy")) : hide($("busy")); }

let toastTimer = null;
function toast(msg, kind = "ok") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(t), 3500);
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function fmtSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / 1048576).toFixed(1) + " Mo";
  if (bytes > 1024) return Math.round(bytes / 1024) + " Ko";
  return bytes + " o";
}

/* ---------------------------------------------------------------- connexion */

let PROVIDERS = [];

function fillProviderFields(p) {
  $("imap_host").value = p.imap_host;
  $("imap_port").value = p.imap_port;
  $("smtp_host").value = p.smtp_host;
  $("smtp_port").value = p.smtp_port;
  $("smtp_ssl").checked = !!p.smtp_ssl;
  const note = $("provider-note");
  if (p.note) { note.textContent = "💡 " + p.note; show(note); } else { hide(note); }
  if (p.id === "custom") $("advanced").open = true;
}

async function initLogin() {
  const res = await call("list_providers");
  PROVIDERS = res.providers || [];
  const sel = $("provider");
  sel.innerHTML = PROVIDERS.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  sel.onchange = () => {
    const p = PROVIDERS.find(x => x.id === sel.value);
    if (p) fillProviderFields(p);
  };
  if (PROVIDERS.length) fillProviderFields(PROVIDERS[0]);

  // reprise automatique du compte actif (jeton d'onglet, sinon mot de passe
  // enregistré) ; sinon simple préremplissage du formulaire
  const acc = getAccount(activeEmail) || accounts()[0];
  if (acc) {
    prefillLogin(acc);
    await tryActivate(acc.email, true);
  }
}

/* préremplit le formulaire de connexion avec un compte connu */
function prefillLogin(acc) {
  $("email").value = acc.email || "";
  if (acc.provider_id) $("provider").value = acc.provider_id;
  $("imap_host").value = acc.imap_host || "";
  $("imap_port").value = acc.imap_port || 993;
  $("smtp_host").value = acc.smtp_host || "";
  $("smtp_port").value = acc.smtp_port || 465;
  $("smtp_ssl").checked = acc.smtp_ssl !== false;
  $("password").value = "";
  if (acc.password_b64) show($("saved-pass-note")); else hide($("saved-pass-note"));
}

/* active un compte : jeton d'onglet → mot de passe enregistré → formulaire */
async function tryActivate(email, silent) {
  const acc = getAccount(email);
  if (!acc) return false;
  setActive(email);
  const tok = tokens()[email];
  if (tok) {
    TOKEN = tok;
    const res = await rpc("list_folders", {});
    if (res.ok) {
      setOnline(true);
      enterMailbox(email, res.folders);
      return true;
    }
  }
  if (acc.password_b64) {
    if (!silent) busy(true);
    const res = await call("connect", { ...acc }, true, true);
    if (!silent) busy(false);
    if (res.ok) {
      setOnline(true);
      enterMailbox(res.email, res.folders);
      return true;
    }
    if (!silent) toast(res.error, "err");
  }
  // pas de session possible sans action de l'utilisateur → formulaire prérempli
  hide($("main-screen"));
  show($("login-screen"));
  prefillLogin(acc);
  if (acc.google_oauth && !silent) {
    toast("Reconnecte ce compte avec le bouton Google 👇", "err");
  }
  return false;
}

function setOnline(on) {
  online = on;
  on ? hide($("offline-badge")) : show($("offline-badge"));
}

async function tryReconnect(silent) {
  const res = await call("reconnect");
  if (!res.ok) {
    if (!silent) toast("Toujours hors ligne : " + res.error, "err");
    else toast("📴 Hors ligne — messages du cache local affichés", "err");
    return false;
  }
  setOnline(true);
  renderFolders(res.folders);
  const raw = currentFolder && currentFolder.raw;
  const again = res.folders.find(f => f.raw === raw)
    || res.folders.find(f => f.raw.toUpperCase() === "INBOX") || res.folders[0];
  if (again) openFolder(again);
  refreshAutoreplyBadge();
  toast("Connecté — boîte synchronisée ✅");
  return true;
}

async function doConnect() {
  const err = $("login-error");
  hide(err);
  const config = {
    provider_id: $("provider").value,
    email: $("email").value.trim(),
    password: $("password").value,
    imap_host: $("imap_host").value.trim(),
    imap_port: parseInt($("imap_port").value, 10) || 993,
    smtp_host: $("smtp_host").value.trim(),
    smtp_port: parseInt($("smtp_port").value, 10) || 465,
    smtp_ssl: $("smtp_ssl").checked,
  };
  if (!config.email || !config.imap_host) {
    err.textContent = "Adresse e-mail et serveur IMAP obligatoires.";
    show(err);
    return;
  }
  const useSaved = !config.password;
  busy(true);
  const res = await call("connect", config, $("remember").checked, useSaved);
  busy(false);
  if (!res.ok) {
    err.textContent = "❌ " + res.error;
    show(err);
    return;
  }
  setOnline(true);
  enterMailbox(res.email, res.folders);
  refreshAutoreplyBadge();
}

/* ---------------------------------------------------------------- dossiers */

function enterMailbox(mail, folders) {
  hide($("login-screen"));
  show($("main-screen"));
  $("account-mail").textContent = mail;
  $("avatar").textContent = (mail[0] || "?").toUpperCase();
  buildAccountMenu();
  renderFolders(folders);
  const inbox = folders.find(f => f.raw.toUpperCase() === "INBOX") || folders[0];
  if (inbox) openFolder(inbox);
}

/* ----------------------------------------------------------- multi-comptes */

function buildAccountMenu() {
  const menu = $("account-menu");
  menu.innerHTML = "";
  accounts().forEach((a) => {
    const b = document.createElement("button");
    b.innerHTML = (a.email === activeEmail ? "✓ " : "") + esc(a.email);
    if (a.email === activeEmail) b.classList.add("acc-active");
    b.onclick = (e) => {
      e.stopPropagation();
      hide(menu);
      if (a.email !== activeEmail) switchAccount(a.email);
    };
    menu.appendChild(b);
  });
  const add = document.createElement("button");
  add.textContent = "➕ Ajouter un compte";
  add.onclick = (e) => { e.stopPropagation(); hide(menu); addAccount(); };
  menu.appendChild(add);
}

async function switchAccount(email) {
  closeReader();
  currentFolder = null;
  busy(true);
  const ok = await tryActivate(email, false);
  busy(false);
  if (ok) toast("Compte actif : " + email);
}

function addAccount() {
  // retour au formulaire vierge, sans toucher aux sessions existantes
  hide($("main-screen"));
  show($("login-screen"));
  $("email").value = "";
  $("password").value = "";
  hide($("saved-pass-note"));
  hide($("login-error"));
  if (PROVIDERS.length) {
    $("provider").value = PROVIDERS[0].id;
    fillProviderFields(PROVIDERS[0]);
  }
}

function renderFolders(folders) {
  FOLDERS = folders;
  const nav = $("folder-list");
  nav.innerHTML = "";
  folders.forEach(f => {
    const el = document.createElement("div");
    el.className = "folder";
    el.dataset.raw = f.raw;
    el.title = f.name;
    el.innerHTML = `<span class="f-name">${esc(f.name)}</span>`
      + (f.unseen ? `<span class="f-count">${f.unseen}</span>` : "");
    el.onclick = () => openFolder(f);
    el.oncontextmenu = (e) => { e.preventDefault(); openFolderMenu(f, e); };
    if (currentFolder && f.raw === currentFolder.raw) el.classList.add("active");
    nav.appendChild(el);
  });
  // options « Déplacer vers… »
  const sel = $("move-select");
  sel.innerHTML = '<option value="">📁 Déplacer vers…</option>'
    + folders.map(f => `<option value="${esc(f.raw)}">${esc(f.name)}</option>`).join("");
}

async function refreshFolders() {
  const res = await call("list_folders");
  if (res.ok) renderFolders(res.folders);
}

function openFolderMenu(folder, event) {
  ctxFolder = folder;
  const menu = $("folder-menu");
  menu.style.left = Math.min(event.clientX, window.innerWidth - 180) + "px";
  menu.style.top = Math.min(event.clientY, window.innerHeight - 90) + "px";
  show(menu);
}

async function createFolder() {
  const name = prompt("Nom du nouveau dossier :");
  if (!name) return;
  busy(true);
  const res = await call("create_folder", name);
  busy(false);
  if (!res.ok) { toast(res.error, "err"); return; }
  renderFolders(res.folders);
  toast("Dossier créé 📁");
}

async function renameCtxFolder() {
  hide($("folder-menu"));
  if (!ctxFolder) return;
  const name = prompt("Nouveau nom :", ctxFolder.name);
  if (!name || name === ctxFolder.name) return;
  busy(true);
  const res = await call("rename_folder", ctxFolder.raw, name);
  busy(false);
  if (!res.ok) { toast(res.error, "err"); return; }
  renderFolders(res.folders);
  toast("Dossier renommé ✏️");
}

async function deleteCtxFolder() {
  hide($("folder-menu"));
  if (!ctxFolder) return;
  if (!confirm(`Supprimer le dossier « ${ctxFolder.name} » et son contenu ?`)) return;
  busy(true);
  const res = await call("delete_folder", ctxFolder.raw);
  busy(false);
  if (!res.ok) { toast(res.error, "err"); return; }
  if (currentFolder && currentFolder.raw === ctxFolder.raw) {
    currentFolder = null;
    const inbox = res.folders.find(f => f.raw.toUpperCase() === "INBOX");
    renderFolders(res.folders);
    if (inbox) openFolder(inbox);
  } else {
    renderFolders(res.folders);
  }
  toast("Dossier supprimé 🗑️");
}

/* ---------------------------------------------------------------- liste */

async function openFolder(folder) {
  currentFolder = folder;
  lastListUid = null;
  searchMode = false;
  $("search").value = "";
  hide($("btn-search-clear"));
  document.querySelectorAll(".folder").forEach(el =>
    el.classList.toggle("active", el.dataset.raw === folder.raw));
  $("folder-title").textContent = folder.name;
  $("message-list").innerHTML = '<div class="empty-list">Chargement…</div>';
  closeReader();
  const res = await call("list_messages", folder.raw, null);
  if (!res.ok) {
    $("message-list").innerHTML = `<div class="empty-list">❌ ${esc(res.error)}</div>`;
    return;
  }
  renderMessages(res.messages, false);
  res.has_more ? show($("btn-more")) : hide($("btn-more"));
}

function renderMessages(messages, append) {
  const list = $("message-list");
  if (!append) list.innerHTML = "";
  if (!messages.length && !append) {
    list.innerHTML = '<div class="empty-list">Aucun message 🌵</div>';
    return;
  }
  messages.forEach(m => {
    const el = document.createElement("div");
    el.className = "msg-item" + (m.seen ? "" : " unseen");
    el.dataset.uid = m.uid;
    el.innerHTML = `
      <div class="m-from"><span>${esc(m.from_name)}</span><span class="m-date">${esc(m.date)}</span></div>
      <div class="m-subj">${m.flagged ? '<span class="m-star">★</span>' : ""}${m.answered ? "↩️ " : ""}${esc(m.subject)}</div>`;
    el.onclick = () => openMessage(m.uid, el);
    list.appendChild(el);
    lastListUid = m.uid;
  });
}

async function loadMore() {
  if (!currentFolder || lastListUid == null || searchMode) return;
  const res = await call("list_messages", currentFolder.raw, lastListUid);
  if (!res.ok) { toast(res.error, "err"); return; }
  renderMessages(res.messages, true);
  if (!res.has_more) hide($("btn-more"));
}

async function doSearch() {
  const q = $("search").value.trim();
  if (!currentFolder) return;
  if (!q) { openFolder(currentFolder); return; }
  searchMode = true;
  show($("btn-search-clear"));
  hide($("btn-more"));
  $("message-list").innerHTML = '<div class="empty-list">Recherche…</div>';
  closeReader();
  const res = await call("search_messages", currentFolder.raw, q);
  if (!res.ok) {
    $("message-list").innerHTML = `<div class="empty-list">❌ ${esc(res.error)}</div>`;
    return;
  }
  $("folder-title").textContent = `${currentFolder.name} — « ${q} »`;
  renderMessages(res.messages, false);
}

/* ---------------------------------------------------------------- lecture */

function closeReader() {
  currentMessage = null;
  hide($("reader"));
  show($("reader-empty"));
}

async function openMessage(uid, el) {
  document.querySelectorAll(".msg-item").forEach(x => x.classList.remove("active"));
  if (el) el.classList.add("active");
  busy(true);
  const res = await call("get_message", currentFolder.raw, uid);
  busy(false);
  if (!res.ok) { toast(res.error, "err"); return; }
  const m = res.message;
  currentMessage = m;
  if (el) el.classList.remove("unseen");

  $("msg-subject").textContent = m.subject;
  $("msg-from").innerHTML = `De : <b>${esc(m.from_name)}</b> &lt;${esc(m.from_addr)}&gt;`;
  $("msg-date").textContent = m.date;
  $("msg-to").textContent = "À : " + m.to + (m.cc ? " — Cc : " + m.cc : "");
  setStarUi(m.flagged);

  const att = $("msg-attachments");
  if (m.attachments && m.attachments.length) {
    att.innerHTML = m.attachments.map((a, i) =>
      `<span class="attachment-chip click" data-i="${i}" title="Enregistrer">` +
      `📎 ${esc(a.name)} (${fmtSize(a.size)})</span>`).join("");
    att.querySelectorAll(".attachment-chip").forEach(chip =>
      chip.onclick = () => downloadAttachment(parseInt(chip.dataset.i, 10)));
    show(att);
  } else hide(att);

  $("msg-body").srcdoc =
    `<base target="_blank"><style>body{font-family:Segoe UI,sans-serif;margin:16px;word-wrap:break-word}</style>`
    + m.html;

  $("move-select").value = "";
  hide($("reader-empty"));
  show($("reader"));
}

function setStarUi(on) {
  const b = $("btn-star");
  b.textContent = on ? "★" : "☆";
  b.classList.toggle("on", on);
}

async function toggleStar() {
  if (!currentMessage) return;
  const on = !currentMessage.flagged;
  const res = await call("set_star", currentFolder.raw, currentMessage.uid, on);
  if (!res.ok) { toast(res.error, "err"); return; }
  currentMessage.flagged = on;
  setStarUi(on);
  const item = document.querySelector(`.msg-item[data-uid="${currentMessage.uid}"] .m-subj`);
  if (item) {
    const star = item.querySelector(".m-star");
    if (on && !star) item.insertAdjacentHTML("afterbegin", '<span class="m-star">★</span>');
    if (!on && star) star.remove();
  }
}

async function markUnread() {
  if (!currentMessage) return;
  const res = await call("set_read", currentFolder.raw, currentMessage.uid, false);
  if (!res.ok) { toast(res.error, "err"); return; }
  const item = document.querySelector(`.msg-item[data-uid="${currentMessage.uid}"]`);
  if (item) item.classList.add("unseen");
  closeReader();
  refreshFolders();
  toast("Marqué comme non lu ✉️");
}

async function downloadAttachment(index) {
  busy(true);
  const res = await call("save_attachment", currentFolder.raw, currentMessage.uid, index);
  busy(false);
  if (!res.ok) { toast(res.error, "err"); return; }
  if (res.saved) toast("Enregistré : " + res.saved);
}

async function moveCurrent(dest) {
  if (!currentMessage || !dest) return;
  busy(true);
  const res = await call("move_message", currentFolder.raw, currentMessage.uid, dest);
  busy(false);
  if (!res.ok) { toast(res.error, "err"); return; }
  toast("Message déplacé 📁");
  openFolder(currentFolder);
  refreshFolders();
}

async function archiveCurrent() {
  if (!currentMessage) return;
  busy(true);
  const res = await call("archive_message", currentFolder.raw, currentMessage.uid);
  busy(false);
  if (!res.ok) { toast(res.error, "err"); return; }
  toast("Message archivé 🗄️");
  openFolder(currentFolder);
  refreshFolders();
}

async function deleteCurrent() {
  if (!currentMessage) return;
  busy(true);
  const res = await call("delete_message", currentFolder.raw, currentMessage.uid);
  busy(false);
  if (!res.ok) { toast(res.error, "err"); return; }
  toast(res.how === "trash" ? "Déplacé vers la corbeille 🗑️"
                            : "Message supprimé définitivement");
  openFolder(currentFolder);
  refreshFolders();
}

/* ---------------------------------------------------------------- rédaction */

function renderComposeAttachments() {
  const box = $("c-attachments");
  box.innerHTML = composeAttachments.map((a, i) =>
    `<span class="attachment-chip click" data-i="${i}" title="Retirer">` +
    `📎 ${esc(a.name)} (${fmtSize(a.size)}) ✕</span>`).join("");
  box.querySelectorAll(".attachment-chip").forEach(chip =>
    chip.onclick = () => {
      composeAttachments.splice(parseInt(chip.dataset.i, 10), 1);
      renderComposeAttachments();
    });
}

function openCompose(mode) {
  replyTo = null;
  composeAttachments = [];
  renderComposeAttachments();
  $("compose-error").classList.add("hidden");
  if (mode === "reply" && currentMessage) {
    replyTo = currentMessage.message_id || "";
    $("compose-title").textContent = "Répondre";
    $("c-to").value = currentMessage.from_addr;
    $("c-cc").value = "";
    const subj = currentMessage.subject;
    $("c-subject").value = /^re\s*:/i.test(subj) ? subj : "Re: " + subj;
    $("c-body").value = "\n\n----- Message d'origine -----\nDe : "
      + currentMessage.from_name + "\nDate : " + currentMessage.date + "\n";
  } else if (mode === "forward" && currentMessage) {
    $("compose-title").textContent = "Transférer";
    $("c-to").value = "";
    $("c-cc").value = "";
    const subj = currentMessage.subject;
    $("c-subject").value = /^(fwd?|tr)\s*:/i.test(subj) ? subj : "Fwd: " + subj;
    $("c-body").value = "\n\n----- Message transféré -----\nDe : "
      + currentMessage.from_name + " <" + currentMessage.from_addr + ">\nDate : "
      + currentMessage.date + "\nObjet : " + currentMessage.subject + "\n";
  } else {
    $("compose-title").textContent = "Nouveau message";
    $("c-to").value = ""; $("c-cc").value = "";
    $("c-subject").value = ""; $("c-body").value = "";
  }
  show($("compose-overlay"));
  $("c-to").focus();
}

async function pickAttachments() {
  const res = await call("pick_attachments");
  if (!res.ok) { toast(res.error, "err"); return; }
  composeAttachments.push(...(res.files || []));
  renderComposeAttachments();
}

/* --------- glisser-déposer de fichiers --------- */

const MAX_DROP_MB = 25;

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function addDroppedFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  busy(true);
  for (const f of files) {
    if (f.size > MAX_DROP_MB * 1024 * 1024) {
      toast(`Trop lourd (max ${MAX_DROP_MB} Mo) : ${f.name}`, "err");
      continue;
    }
    try {
      composeAttachments.push({ name: f.name, size: f.size,
                                b64: await fileToB64(f) });
    } catch (e) {
      toast("Lecture impossible : " + f.name, "err");
    }
  }
  busy(false);
  renderComposeAttachments();
  toast("📎 " + composeAttachments.length + " pièce(s) jointe(s)");
}

function bindDragDrop() {
  const card = document.querySelector(".compose-card");
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!$("compose-overlay").classList.contains("hidden") && card)
      card.classList.add("dragover");
  });
  window.addEventListener("dragleave", (e) => {
    if (card && (e.target === document.body || !e.relatedTarget))
      card.classList.remove("dragover");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (card) card.classList.remove("dragover");
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    // pas encore connecté → on ignore ; sinon on ouvre la rédaction au besoin
    if ($("main-screen").classList.contains("hidden")) return;
    if ($("compose-overlay").classList.contains("hidden")) openCompose("new");
    addDroppedFiles(files);
  });
}

async function doSend() {
  const err = $("compose-error");
  hide(err);
  const to = $("c-to").value.trim();
  if (!to) { err.textContent = "Il faut au moins un destinataire."; show(err); return; }
  busy(true);
  const res = await call("send_message", to, $("c-subject").value.trim(),
                         $("c-body").value, $("c-cc").value.trim(), replyTo || "",
                         composeAttachments);
  busy(false);
  if (!res.ok) { err.textContent = "❌ " + res.error; show(err); return; }
  hide($("compose-overlay"));
  toast("Message envoyé 📤");
}

async function doSaveDraft() {
  busy(true);
  const res = await call("save_draft", $("c-to").value.trim(),
                         $("c-subject").value.trim(), $("c-body").value,
                         $("c-cc").value.trim());
  busy(false);
  if (!res.ok) { toast(res.error, "err"); return; }
  hide($("compose-overlay"));
  toast("Brouillon enregistré dans « " + res.folder + " » 💾");
  refreshFolders();
}

/* ---------------------------------------------------------------- paramètres */

async function openSettings() {
  const res = await call("get_settings");
  if (!res.ok) { toast(res.error, "err"); return; }
  const s = res.settings;
  $("s-signature").value = s.signature || "";
  $("s-ar-enabled").checked = false;
  $("s-ar-enabled").disabled = true;   // répondeur : app de bureau uniquement
  $("s-ar-subject").value = "";
  $("s-ar-body").value = s.autoreply.body || "";
  updateArFields();
  show($("settings-overlay"));
}

function updateArFields() {
  $("ar-fields").classList.toggle("off", !$("s-ar-enabled").checked);
}

async function saveSettings() {
  const settings = {
    signature: $("s-signature").value,
    autoreply: {
      enabled: $("s-ar-enabled").checked,
      subject: $("s-ar-subject").value.trim(),
      body: $("s-ar-body").value,
    },
  };
  busy(true);
  const res = await call("save_settings", settings);
  busy(false);
  if (!res.ok) { toast(res.error, "err"); return; }
  hide($("settings-overlay"));
  refreshAutoreplyBadge(settings);
  toast("Paramètres enregistrés ⚙️");
}

async function refreshAutoreplyBadge(settings) {
  if (!settings) {
    const res = await call("get_settings");
    if (!res.ok) return;
    settings = res.settings;
  }
  settings.autoreply.enabled ? show($("autoreply-badge")) : hide($("autoreply-badge"));
}

/* ---------------------------------------------------------------- session */

async function doLogout() {
  const forget = confirm(
    `Retirer aussi le compte ${activeEmail} de la liste sur ce navigateur ?\n` +
    "(Annuler = garder le compte, juste fermer la session)");
  busy(true);
  await call("disconnect", forget);
  busy(false);
  setOnline(false);
  // s'il reste d'autres comptes, basculer sur le premier ; sinon formulaire
  const rest = accounts().filter((a) => a.email !== activeEmail || !forget);
  const next = rest.find((a) => a.email !== activeEmail);
  if (next) {
    switchAccount(next.email);
    return;
  }
  hide($("main-screen"));
  show($("login-screen"));
  $("password").value = "";
  if (forget) { $("email").value = ""; hide($("saved-pass-note")); }
}

/* ---------------------------------------------------------------- init */

/* --------- retour de « Se connecter avec Google » --------- */

async function handleOauthReturn() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const error = hash.get("oauth_error");
  const token = hash.get("gm");
  const email = hash.get("em");
  if (!error && !token) return false;
  history.replaceState(null, "", window.location.pathname); // nettoyer l'URL
  if (error) {
    const err = $("login-error");
    err.textContent = "❌ " + error;
    show(err);
    return false;
  }
  upsertAccount({ email, provider_id: "gmail", google_oauth: true,
                  imap_host: "imap.gmail.com", imap_port: 993,
                  smtp_host: "smtp.gmail.com", smtp_port: 465, smtp_ssl: true });
  setActive(email);
  setTokenFor(email, token);
  busy(true);
  const res = await call("list_folders");
  busy(false);
  if (!res.ok) {
    const err = $("login-error");
    err.textContent = "❌ " + (res.error || "Connexion Google échouée");
    show(err);
    return false;
  }
  setOnline(true);
  enterMailbox(email, res.folders);
  toast("Connecté avec Google ✅");
  return true;
}

function bind() {
  $("btn-connect").onclick = doConnect;
  $("btn-google").onclick = () => {
    window.location.href = "/api/mail/oauth/google/start";
  };
  $("password").addEventListener("keydown", e => { if (e.key === "Enter") doConnect(); });
  $("btn-refresh").onclick = () => {
    if (!online) { busy(true); tryReconnect(false).then(() => busy(false)); return; }
    refreshFolders();
    if (currentFolder) openFolder(currentFolder);
  };
  $("btn-logout").onclick = doLogout;
  $("btn-compose").onclick = () => openCompose("new");
  $("btn-reply").onclick = () => openCompose("reply");
  $("btn-forward").onclick = () => openCompose("forward");
  $("btn-delete").onclick = deleteCurrent;
  $("btn-archive").onclick = archiveCurrent;
  $("btn-unread").onclick = markUnread;
  $("btn-star").onclick = toggleStar;
  $("move-select").onchange = (e) => moveCurrent(e.target.value);
  $("btn-compose-close").onclick = () => hide($("compose-overlay"));
  $("btn-send").onclick = doSend;
  $("btn-draft").onclick = doSaveDraft;
  $("btn-attach").onclick = pickAttachments;
  $("btn-more").onclick = loadMore;
  $("btn-new-folder").onclick = createFolder;
  $("ctx-rename").onclick = renameCtxFolder;
  $("ctx-delete").onclick = deleteCtxFolder;
  $("btn-settings").onclick = openSettings;
  $("btn-settings-close").onclick = () => hide($("settings-overlay"));
  $("btn-settings-save").onclick = saveSettings;
  $("s-ar-enabled").onchange = updateArFields;
  $("search").addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
  $("btn-search-clear").onclick = () => { $("search").value = ""; openFolder(currentFolder); };
  $("account-btn").onclick = (e) => {
    e.stopPropagation();
    buildAccountMenu();
    $("account-menu").classList.toggle("hidden");
  };
  bindDragDrop();
  document.addEventListener("click", () => {
    hide($("folder-menu"));
    hide($("account-menu"));
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      hide($("compose-overlay"));
      hide($("settings-overlay"));
      hide($("folder-menu"));
      hide($("account-menu"));
    }
  });
}

let started = false;
function start() {
  if (started) return;
  started = true;
  bind();
  initLogin().then(() => handleOauthReturn());
}

start();
