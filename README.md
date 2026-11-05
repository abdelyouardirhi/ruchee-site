# Site Ruchée

Site statique et court échange vocal : accueil → prénom écrit ou dicté → réponse avec le prénom → carte e-mail dans le chat.

Il n'y a pas de modèle conversationnel ni de parcours à choix. Les textes sont dans `chat-content.js`. Mistral prononce la réponse et, uniquement si le visiteur choisit le micro, transcrit son prénom. Brevo envoie la présentation demandée.

## Développement

Node 22.15 ou plus récent :

```sh
npm install
npm run check
npm run build
npm run preview
```

L'aperçu tourne sur http://localhost:4174 et sert seulement `dist/`. Les e-mails y sont **toujours désactivés**. La base de quotas locale est en mémoire ; redémarrer le serveur la remet à zéro. Ce serveur est destiné au développement, jamais à la production.

Le port peut être choisi avec `PORT`, par exemple `PORT=4173 npm run preview`.

Pour activer explicitement la voix dans l'aperçu avec une clé déjà présente dans un fichier local sécurisé :

```sh
node --env-file=/chemin/vers/un/fichier.env --import tsx scripts/preview.mjs --live-voice
```

Seule `MISTRAL_VOICE_API_KEY` est utilisée pour la voix. La clé de texte Azure n'est jamais utilisée en remplacement. L'aperçu limite par défaut chaque action vocale à 5 appels par jour et par processus. Il n'envoie rien au prestataire au démarrage : les appels nécessitent une action du visiteur.

## Accueil Généré Une Fois

`audio/lea-accueil-v1.mp3` est l'accueil fixe, voix Manon, expressivité 3. Le JSON à côté du MP3 contient le texte, la configuration et le SHA-256, sans secret.

```sh
node --env-file=/chemin/vers/un/fichier.env scripts/generate-welcome.mjs
```

Un fichier existant et conforme est réutilisé sans appel API. Si le texte a changé, le programme refuse de payer une nouvelle génération sans l'option explicite `--force`. Une exécution autorise au maximum une tentative, sans reprise automatique.

L'accueil se lit après le clic sur « Parler à Léa ». Une ouverture par URL directe n'impose pas de son : le bouton « Écouter » reste disponible. Les navigateurs peuvent limiter la lecture automatique ; le texte reste toujours accessible.

## Voix Et Budget

`POST /api/voice?action=greet` accepte uniquement un prénom validé et construit le texte de la réponse côté serveur. Il ne peut pas prononcer un texte arbitraire fourni par le visiteur.

`POST /api/voice?action=transcribe` accepte uniquement un WAV PCM16 mono 16 kHz canonique, entre 0,2 et 6 secondes. La durée est vérifiée côté serveur à partir du format et de la taille réels, pas d'une valeur déclarée par le navigateur. Les données sont envoyées à Mistral, sans stockage audio dans D1. Le prénom reconnu reste corrigeable avant validation.

- Accueil : un fichier statique, aucune nouvelle génération par visiteur.
- Prénom écrit : une synthèse vocale courte.
- Micro utilisé : une transcription de 6 secondes maximum, puis une synthèse après confirmation du prénom.
- Aucune nouvelle génération quand le chat est rouvert ou qu'un prénom déjà traité est réécouté sur la même page.
- Quotas atomiques D1 : 5 appels par IP/heure/action et 50 appels maximum par jour UTC/action. `VOICE_DAILY_LIMIT` permet de réduire ce plafond.
- Limite de 240 caractères par réponse synthétisée ; aucun LLM de conversation.

À titre indicatif, avec les prix estimés documentés dans l'agent le 4 novembre 2026 (13 $/million de caractères et 0,0035 $/minute transcrite), les plafonds complets correspondent à environ **0,18 $/jour** de voix, hors hébergement et e-mails. Ce n'est pas une garantie tarifaire : vérifier les prix du prestataire avant activation.

## Configuration De Production

Créer une base Cloudflare D1 et appliquer les migrations `0001_recap.sql` et `0002_voice.sql`. Ajouter sa liaison dans `wrangler.jsonc` :

```json
"d1_databases": [{
  "binding": "RECAP_DB",
  "database_name": "ruchee-recaps",
  "database_id": "IDENTIFIANT_FOURNI_PAR_CLOUDFLARE",
  "migrations_dir": "migrations"
}]
```

Configurer les variables et secrets du projet Pages, uniquement sur les environnements à activer :

| Variable                | Rôle                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| `RECAP_HASH_KEY`        | Secret aléatoire d'au moins 32 caractères pour les empreintes anti-abus |
| `RECAP_ALLOWED_ORIGINS` | Origines exactes, par exemple `https://ruchee.fr,https://www.ruchee.fr` |
| `VOICE_ENABLED`         | `true` pour autoriser la voix dynamique                                 |
| `MISTRAL_VOICE_API_KEY` | Clé Mistral dédiée à la voix, côté serveur uniquement                   |
| `VOICE_DAILY_LIMIT`     | Entre 1 et 50, par action ; défaut 50 en production                     |
| `RECAP_EMAIL_ENABLED`   | `true` pour autoriser les e-mails                                       |
| `BREVO_API_KEY`         | Clé API Brevo, pas la clé SMTP de Supabase                              |
| `RECAP_SENDER_EMAIL`    | Adresse vérifiée par Brevo                                              |
| `RECAP_DAILY_LIMIT`     | Entre 1 et 50 ; défaut 50                                               |

Sans configuration complète, les endpoints refusent l'appel sans contacter le prestataire. Le texte reste disponible si la voix est bloquée. Ne pas activer les e-mails sur les aperçus. Authentifier le domaine d'envoi chez Brevo et désactiver le suivi d'ouverture/clics ; préserver les MX/SPF existants dans le DNS Cloudflare.

## E-mail Et Protection

L'endpoint `/api/recap` n'accepte plus de scénario : le visiteur demande la présentation générale de Ruchée. Il reçoit un seul e-mail en texte brut, sans inscription à une liste et sans BCC au fondateur.

Les protections existantes sont conservées : 50 réservations d'envoi par jour UTC, 5 tentatives par IP/heure, un envoi par destinataire sur 24 heures. Les refus connus peuvent être réessayés explicitement ; une réponse incertaine, une erreur 5xx ou une demande restée en attente ne déclenchent pas un nouvel envoi automatique.

D1 stocke seulement des identifiants, types de demandes, états, dates et empreintes HMAC. Les entrées de plus de 48 heures sont purgées lors de nouvelles demandes sur le service concerné. **En l'absence de trafic, elles restent physiquement présentes** : prévoir une purge planifiée si une suppression à échéance fixe est nécessaire.

Les réponses vocales personnalisées sont gardées en mémoire dans le navigateur pour éviter de repayer la même phrase. Ni les enregistrements du micro ni les réponses audio ne sont stockés dans la base de quotas. Les règles de conservation propres à Mistral et Brevo doivent être vérifiées séparément.

## Déploiement

Après validation et autorisation de publier, depuis la racine du dépôt :

```sh
npm run check
npm run build
npx wrangler@4.20.0 pages deploy dist --project-name ruchee --branch main
```

`dist/` contient une liste explicite de fichiers publics. Ne jamais publier la racine, les secrets, les tests ou les migrations. Wrangler compile les Functions séparément ; `_routes.json` ne fait exécuter une Function que pour `/api/voice` et `/api/recap`.

Les tests du backend utilisent SQLite en mémoire et des prestataires simulés. Aucun test automatisé ne doit envoyer de véritable e-mail ni consommer de voix sans autorisation explicite.
