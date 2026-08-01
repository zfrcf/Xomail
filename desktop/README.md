# 📬 Xomail Desktop

Application de bureau reproduisant **exactement** l'interface de la version web
Xomail, mais 100 % en local : un serveur mail Python (IMAP/SMTP) tourne dans le
processus et l'interface web « parfaite » s'affiche dans une fenêtre native
(pywebview). Tes identifiants ne quittent jamais ta machine.

## Lancer depuis les sources

```bash
pip install pywebview
python main.py
```

## Compiler l'exe

```bash
build_windows.bat        # → dist\Xomail.exe (aucun prérequis pour l'utilisateur)
```

`python main.py --selftest` vérifie serveur + API + interface sans ouvrir de fenêtre.

## Architecture

| Fichier | Rôle |
|---|---|
| `main.py` | fenêtre pywebview → `http://127.0.0.1:8771` |
| `server.py` | serveur HTTP local reproduisant le contrat de l'API web (`/api/mail/*`) |
| `mail_client.py` | moteur IMAP/SMTP (dossiers, messages, recherche, envoi, XOAUTH2) |
| `gofile.py` | pièces jointes téléversées sur Gofile → liens dans le mail |
| `providers.py` | préréglages fournisseurs |
| `web/` | interface (HTML/CSS/JS), identique à la version web |
| `serve.py` | serveur seul (sans fenêtre), pour tests/aperçu |

## Fonctions (identiques à la version web)

Multi-comptes, tous fournisseurs IMAP/SMTP, « Se connecter avec Google »
(OAuth via navigateur système + loopback), dossiers, recherche, étoiles,
archivage, corbeille, brouillons, réponse/transfert, signature, et
**pièces jointes transformées en liens Gofile** (plus de blocage Gmail 552).
