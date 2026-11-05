# Site Ruchée

Site statique et « Parler à Léa » : vidéo de Léa → vocal au dirigeant « qu’est-ce qui vous complique le plus la vie ? » → le visiteur choisit une réponse → vocal de Léa adapté à ce choix → carte prénom, téléphone, e-mail → e-mail affiché dans le chat.

Aucun modèle conversationnel, aucun micro, aucune voix générée en direct. Tous les textes sont dans `chat-content.js` ; les vocaux de Léa sont des MP3 fixes. Seul `/api/recap` tourne côté serveur (Brevo envoie les e-mails).

## Développement

Node 22.15 ou plus récent :

```sh
npm install
npm run check
npm run build
npm run preview
```

L'aperçu tourne sur http://localhost:4174 (`PORT` pour changer) et sert seulement `dist/`. Les e-mails y sont **toujours désactivés** : la carte de rappel affiche le message de secours. Les quotas locaux sont en mémoire et repartent à zéro à chaque redémarrage.

## Vocaux de Léa

Voix « Léa (vidéo) » (voix Mistral clonée depuis la vidéo d'accueil, id dans `chat-content.js`), Voxtral TTS, expressivité 3. Chaque MP3 a un JSON à côté (texte, modèle, voix, SHA-256, sans secret) ; `tests/content.test.ts` vérifie qu'ils correspondent aux textes.

```sh
node --env-file=/chemin/vers/un/fichier.env scripts/generate-voice.mjs
```

Seule `MISTRAL_VOICE_API_KEY` est utilisée. Un fichier existant et conforme est réutilisé sans appel API. Si un texte change, changer aussi le nom du fichier (`-v2`…) pour éviter le cache des navigateurs, ou relancer avec `--force`. Une exécution fait au plus une tentative par fichier, sans reprise automatique.

Le premier vocal se lit après le clic sur « Parler à Léa ». Les navigateurs peuvent bloquer la lecture automatique : le bouton lecture et le texte restent toujours disponibles.

## Configuration de production

Créer une base Cloudflare D1 et appliquer `migrations/0001_recap.sql`. Ajouter sa liaison dans `wrangler.jsonc` :

```json
"d1_databases": [{
  "binding": "RECAP_DB",
  "database_name": "ruchee-recaps",
  "database_id": "IDENTIFIANT_FOURNI_PAR_CLOUDFLARE",
  "migrations_dir": "migrations"
}]
```

Variables et secrets du projet Pages :

| Variable                | Rôle                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| `RECAP_HASH_KEY`        | Secret aléatoire d'au moins 32 caractères pour les empreintes anti-abus |
| `RECAP_ALLOWED_ORIGINS` | Origines exactes, par exemple `https://ruchee.fr,https://www.ruchee.fr` |
| `RECAP_EMAIL_ENABLED`   | `true` pour autoriser les e-mails                                       |
| `BREVO_API_KEY`         | Clé API Brevo (pas une clé SMTP)                                        |
| `RECAP_SENDER_EMAIL`    | Adresse vérifiée par Brevo                                              |
| `RECAP_TEAM_EMAIL`      | Qui reçoit « À rappeler » ; défaut `contact@ruchee.fr`                  |
| `RECAP_DAILY_LIMIT`     | Entre 1 et 50 ; défaut 50                                               |

Sans configuration complète, l'endpoint refuse l'appel sans contacter Brevo. Ne pas activer les e-mails sur les aperçus. Authentifier le domaine d'envoi chez Brevo et désactiver le suivi d'ouverture/clics ; préserver les MX/SPF existants dans le DNS Cloudflare.

## E-mails et protection

`POST /api/recap` reçoit `{ name, phone, email, topic, website, requestId }`, où `topic` est l'identifiant d'une réponse de `PAINS`. Deux e-mails en texte brut :

1. « À rappeler » à l'équipe, avec la réponse choisie (répondre écrit directement au contact). Son résultat est l'état de la demande.
2. Une confirmation au visiteur, envoyée une seule fois si le premier est accepté, jamais réessayée.

Protections : 50 réservations par jour UTC, 5 tentatives par IP/heure, un envoi par adresse sur 24 heures, champ piège `website`. Une réponse incertaine ou une demande restée en attente ne déclenche jamais de renvoi automatique.

D1 ne stocke que des identifiants, états, dates et empreintes HMAC. Les entrées de plus de 48 heures sont purgées lors des nouvelles demandes ; **sans trafic, elles restent présentes** : prévoir une purge planifiée si une échéance fixe est nécessaire.

## Déploiement

Depuis la racine du dépôt :

```sh
npm run check
npm run build
npx wrangler@4.20.0 pages deploy dist --project-name ruchee --branch main
```

`dist/` contient une liste explicite de fichiers publics. Ne jamais publier la racine, les secrets, les tests ou les migrations. `_routes.json` ne fait exécuter une Function que pour `/api/recap`.

Les tests utilisent SQLite en mémoire et un Brevo simulé. Aucun test ne doit envoyer de véritable e-mail.
