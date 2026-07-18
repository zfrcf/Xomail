# 📬 Xomail

Webmail autonome en Node.js : **vraies connexions IMAP/SMTP** (imapflow +
nodemailer), **multi-comptes**, et pièces jointes envoyées en **liens
Gofile** au lieu de fichiers. Prêt pour GitHub → Vercel.

## Particularités

- **Multi-comptes** : clique sur ton adresse en haut de la barre latérale →
  liste des comptes, ✓ sur l'actif, « ➕ Ajouter un compte ». La bascule est
  instantanée (un jeton de session par compte).
- **Pièces jointes → liens Gofile** : tout fichier joint (bouton 📎 ou
  glisser-déposer) est téléversé sur Gofile par le serveur, et le mail part
  avec le **lien de téléchargement** dans le corps — plus jamais de rejet
  Gmail `552 BlockedMessage` sur les .exe/.zip. Jeton facultatif
  `GOFILE_API_TOKEN` (page profil gofile.io) pour rattacher les fichiers à
  ton compte Gofile ; sans jeton, envoi en invité.

## Lancer en local

```bash
npm install
node server.js        # → http://localhost:8770
```

## Déployer sur Vercel

Structure prévue pour Vercel : `api/index.js` = la fonction serverless
(toutes les routes `/api/mail/*` y sont réécrites par `vercel.json`),
`public/` = l'interface servie en statique par Vercel directement.

1. Pousse le dépôt sur GitHub.
2. Sur vercel.com → **Add New Project** → importe le dépôt.
   - Si le dépôt est `boite-mail` entier : mets **Root Directory = `webmail`**.
   - Framework Preset : **Other** (aucune commande de build).
3. Dans **Settings → Environment Variables**, ajoute :
   - `MAIL_SECRET` = une longue phrase aléatoire (ex. sortie de
     `openssl rand -base64 32`). **Obligatoire** : c'est la clé qui chiffre
     les jetons de session ; sans elle, chaque instance serverless aurait sa
     propre clé et les sessions seraient perdues à chaque requête.
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` pour le bouton
     « Se connecter avec Google » (voir plus bas — client de type
     **Application Web** requis pour Vercel).
4. Deploy, puis **Redeploy** après tout changement de variables.

En cas d'erreur 500 `FUNCTION_INVOCATION_FAILED`, regarde les journaux :
projet Vercel → Deployments → le déploiement → onglet **Functions/Logs**.

## Comment les identifiants sont gérés

- À la connexion, le serveur vérifie les identifiants auprès du serveur IMAP,
  puis les chiffre (AES-256-GCM avec `MAIL_SECRET`) dans un **jeton renvoyé
  au navigateur**. Le serveur ne stocke rien sur disque.
- À chaque requête, le serveur retrouve la connexion IMAP en mémoire, ou la
  rouvre à partir du jeton (redémarrage, instance Vercel froide…) — c'est ce
  qui rend le webmail compatible serverless.
- Jeton valable 24 h ; connexion IMAP inactive fermée après 30 min.
- « Se souvenir du mot de passe » le garde dans le navigateur (localStorage),
  jamais côté serveur.

⚠️ Comme pour tout webmail (Roundcube, etc.), le mot de passe transite par le
serveur à la connexion : sers toujours le site en HTTPS (Vercel le fait) et
n'héberge ce service que pour toi ou des gens qui te font confiance.

## Fichiers

| Fichier | Rôle |
|---|---|
| `server.js` | Express : interface statique + montage de l'API |
| `mail-api.js` | routes `/api/mail/*` : IMAP (imapflow), SMTP (nodemailer), jetons chiffrés |
| `public/` | interface (HTML/CSS/JS) — identique à l'app de bureau |
| `vercel.json` | configuration de déploiement Vercel |

## Comptes mail

Préréglages : Gmail, Outlook, Yahoo, iCloud, Orange, Free, SFR, La Poste,
OVH + serveurs personnalisés.

### Mot de passe habituel ou pas ?

- **Gmail** : bouton **« Se connecter avec Google »** → tu tapes ton mot de
  passe habituel sur la page de Google (OAuth). Le formulaire classique, lui,
  exige un mot de passe d'application — c'est Google qui l'impose en IMAP.
- **Orange, Free, SFR, La Poste, OVH, personnalisé** : mot de passe habituel
  directement dans le formulaire.
- **Yahoo, iCloud, Outlook** : mot de passe d'application requis (politique
  de ces fournisseurs ; pas de bouton OAuth pour eux ici).

### Configurer « Se connecter avec Google »

Variables d'environnement `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET`
(app OAuth du projet Google Cloud). En local, le client « application de
bureau » accepte la redirection `http://localhost:8770/api/mail/oauth/google/callback`
sans configuration. **Pour Vercel**, crée dans Google Cloud Console
(APIs & Services → Credentials) un client OAuth de type **Application Web**
avec l'URI de redirection :
`https://<ton-app>.vercel.app/api/mail/oauth/google/callback`,
et mets ses identifiants dans les variables d'environnement Vercel.
Si le projet OAuth est en mode « Test », ajoute ton adresse dans les
utilisateurs test (écran de consentement).
