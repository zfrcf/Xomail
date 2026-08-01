# -*- coding: utf-8 -*-
"""Préréglages des fournisseurs de messagerie (IMAP + SMTP)."""

PROVIDERS = [
    {
        "id": "gmail",
        "name": "Gmail",
        "imap_host": "imap.gmail.com", "imap_port": 993,
        "smtp_host": "smtp.gmail.com", "smtp_port": 465, "smtp_ssl": True,
        "note": "Gmail exige un « mot de passe d'application » (compte Google → Sécurité → Validation en deux étapes → Mots de passe des applications).",
    },
    {
        "id": "outlook",
        "name": "Outlook / Hotmail",
        "imap_host": "outlook.office365.com", "imap_port": 993,
        "smtp_host": "smtp-mail.outlook.com", "smtp_port": 587, "smtp_ssl": False,
        "note": "Microsoft bloque parfois l'authentification par mot de passe simple ; activer IMAP dans les paramètres Outlook.com.",
    },
    {
        "id": "yahoo",
        "name": "Yahoo Mail",
        "imap_host": "imap.mail.yahoo.com", "imap_port": 993,
        "smtp_host": "smtp.mail.yahoo.com", "smtp_port": 465, "smtp_ssl": True,
        "note": "Yahoo exige un mot de passe d'application (Sécurité du compte → Gérer les mots de passe d'application).",
    },
    {
        "id": "icloud",
        "name": "iCloud Mail",
        "imap_host": "imap.mail.me.com", "imap_port": 993,
        "smtp_host": "smtp.mail.me.com", "smtp_port": 587, "smtp_ssl": False,
        "note": "iCloud exige un mot de passe d'application (appleid.apple.com → Connexion et sécurité).",
    },
    {
        "id": "orange",
        "name": "Orange",
        "imap_host": "imap.orange.fr", "imap_port": 993,
        "smtp_host": "smtp.orange.fr", "smtp_port": 465, "smtp_ssl": True,
        "note": "",
    },
    {
        "id": "free",
        "name": "Free",
        "imap_host": "imap.free.fr", "imap_port": 993,
        "smtp_host": "smtp.free.fr", "smtp_port": 465, "smtp_ssl": True,
        "note": "Activer l'accès IMAP dans la console Free (Zimbra).",
    },
    {
        "id": "sfr",
        "name": "SFR",
        "imap_host": "imap.sfr.fr", "imap_port": 993,
        "smtp_host": "smtp.sfr.fr", "smtp_port": 465, "smtp_ssl": True,
        "note": "",
    },
    {
        "id": "laposte",
        "name": "La Poste",
        "imap_host": "imap.laposte.net", "imap_port": 993,
        "smtp_host": "smtp.laposte.net", "smtp_port": 465, "smtp_ssl": True,
        "note": "",
    },
    {
        "id": "ovh",
        "name": "OVH",
        "imap_host": "ssl0.ovh.net", "imap_port": 993,
        "smtp_host": "ssl0.ovh.net", "smtp_port": 465, "smtp_ssl": True,
        "note": "",
    },
    {
        "id": "xomad",
        "name": "xomad.fr",
        "imap_host": "mail.yeux.o2switch.net", "imap_port": 993,
        "smtp_host": "mail.yeux.o2switch.net", "smtp_port": 465, "smtp_ssl": True,
        "note": "Adresses @xomad.fr (hébergement o2switch). Adresse complète + mot de passe.",
    },
    {
        "id": "custom",
        "name": "Personnalisé…",
        "imap_host": "", "imap_port": 993,
        "smtp_host": "", "smtp_port": 465, "smtp_ssl": True,
        "note": "Renseigne les serveurs IMAP et SMTP fournis par ton hébergeur.",
    },
]
