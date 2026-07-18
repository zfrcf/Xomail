/*
 * Cœur de l'application Express — partagé entre :
 *   - server.js    (lancement local :  node server.js)
 *   - api/index.js (fonction serverless Vercel)
 */
const path = require("path");
const fs = require("fs");

// mini chargeur .env (aucune dépendance) — les variables déjà définies
// dans l'environnement (Vercel) gardent la priorité
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch { /* pas de .env : variables d'environnement uniquement */ }

const express = require("express");

const app = express();

app.use("/api/mail", require("./mail-api"));

// En local, Express sert aussi l'interface ; sur Vercel, le dossier public/
// est servi directement par la plateforme (la fonction ne reçoit que /api/mail).
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

module.exports = app;
