# Assistant IA de MaCité (Google AI Studio)

## Principe
Le modèle **choisit** une action dans une liste fermée ; il n'écrit aucun fait. Le serveur compose la réponse à partir des lieux **publiés**.
- Actions : `show_place`, `navigate`, `list`, `clarify`, `not_found`. Tout identifiant renvoyé doit appartenir aux candidats envoyés, sinon la réponse est rejetée et un **repli sans IA** (recherche approximative) prend le relais.
- Aucune coordonnée ne vient du modèle. Aucune écriture en base. Le brouillon de relevé (`/ai/survey-draft`) n'est qu'une **proposition** à vérifier ; le circuit releveur → expert → publication reste inchangé.
- Le contenu des lieux et des messages est traité comme **non fiable** (injection d'instructions).
- Votre position GPS sert seulement à trier les résultats **sur votre serveur** ; elle n'est jamais envoyée à Google.
- Le texte des utilisateurs n'est pas journalisé (le journal d'audit ne garde que l'action).

## Activer
1. Dans AI Studio : créer une clé ; choisir un modèle texte et copier son identifiant exact.
2. Sur le serveur (`.env`) : `MACITE_AI_PROVIDER=gemini`, `GEMINI_API_KEY=…`, `GEMINI_MODEL=…`, quotas. **Ne jamais coller la clé dans une conversation, un dépôt ou le code web.**
3. Redémarrer l'API (la migration `0003` crée la table `ai_usage`). Vérifier : `GET /api/v1/ai/status` → `{"enabled": true}`.

## Coûts et limites
- **Gestion du quota texte** : défauts 20 requêtes/utilisateur/jour et 400 global (alignés sur `.env.example`). Un appel à Google qui n'aboutit pas (panne, délai, 429 de Google) est **remboursé** ; une réponse reçue mais inutilisable reste comptée. Une demande sans mot exploitable (« le la ? ») ne consomme rien. `GET /api/v1/ai/usage` donne le reste du jour ; l'application l'affiche, répond **localement** aux désignations sans ambiguïté (« bâtiment D3 ») sans appeler l'IA, et ne contacte plus le serveur une fois le quota épuisé.
- Quota par utilisateur (429) et coupe-circuit global (503) : aucun appel à Google une fois atteints. Les quotas de Google s'appliquent au projet entier, pas par utilisateur : gardez `MACITE_AI_DAILY_GLOBAL` sous la limite quotidienne de votre modèle.
- La limite **par minute** de Google n'est pas contrôlée côté MaCité : en cas de dépassement, Google répond 429 et l'assistant passe en mode simplifié (pas d'erreur).
- Offre gratuite : les requêtes peuvent servir à améliorer les produits de Google ; le texte de consentement de l'application le signale. Vérifiez les conditions en vigueur.

## Dictée et lecture (navigateur, hors Gemini Live)
- Dictée et commandes : reconnaissance vocale **du navigateur** (gratuite). Selon le navigateur, l'audio peut transiter par un service distant. Commandes (liste fermée) : « ajouter un point », « annuler le dernier point », « enregistrer comme brouillon » (confirmation demandée), « commencer un relevé », « terminer le contour ».
- Lecture des réponses : synthèse vocale du navigateur, optionnelle.

# Assistant vocal (Gemini Live) — référence

Désactivé par défaut. **Gemini Live n'est pas validé sur appareil ni avec une vraie clé** (voir « Résultats des tests »). Aucune commande vocale de relevé terrain : phase séparée.

## Architecture de session
- **Qui parle à qui** : l'appareil demande un jeton à NOTRE serveur (`POST /api/v1/ai/live-token`, authentifié, consentement requis) ; le serveur le crée chez Google avec la clé (qui ne quitte jamais le serveur) ; l'appareil ouvre ensuite la session **directement** avec Google via `@google/genai` (v1beta), jeton à usage unique utilisé comme une clé. L'audio ne passe jamais par notre serveur.
- **Verrouillage côté serveur** : modèle, sortie audio, consignes et 3 outils (`find_place`, `show_place`, `start_navigation`) sont placés dans `liveConnectConstraints` du jeton (voir limite connue n° 1). Les outils s'exécutent **sur l'appareil**, sur les lieux publiés déjà téléchargés (hors ligne possible) ; tout identifiant est revérifié, les noms de lieux sont assainis, D3 ≠ D4.
- **Contrôleur immédiat** (`liveSession.ts`) : `startLive()` rend la main tout de suite (`stop()`, `isClosed()`). « Arrêter » vaut à toutes les phases (invite micro, jeton, SDK, connexion, session). Une valeur qui arrive après l'arrêt est libérée aussitôt ; un message ou un outil reçu après fermeture est ignoré ; un double clic arrête la session au lieu d'en ouvrir une seconde (`createLiveToggle`) sans demander de jeton.
- **États** : `connecting` → `listening` ⇄ `speaking` → `closed`, affichés dans `AssistantPanel.tsx`.
- **Nettoyage** (idempotent) : micro et pistes, capture, lecture, minuteurs, session, `AudioContext`.
- **Contexte relu à chaque outil** : lieux, GPS, graphe ; le GPS n'est jamais transmis.
- **Résultat de navigation typé** (`itinerary.ts`) : `route_ready` · `gps_needed` · `no_route` (départ non relié, lieu non relié, aucun chemin, aucun chemin sans escalier) · `place_unavailable` · `error`. Le modèle ne reçoit `ok: true` que si une route existe ; le même message s'affiche à l'écran.
- **Fichiers** : web `lib/liveSession.ts`, `liveAudio.ts`, `liveCapture.ts`, `liveTools.ts`, `itinerary.ts`, `aiClient.ts`, `components/AssistantPanel.tsx` ; API `macite_ai/provider.py`, `router.py`, `security.py`.

## Configuration
1. Clé : AI Studio ; **ne jamais la coller dans une conversation, un dépôt ou le code web**.
2. Modèle Live : copier l'identifiant **exact** depuis la documentation Google (préversion : il change).
3. Serveur (`.env`, voir `.env.example`) : `MACITE_ENV=production`, `MACITE_SECRET` (≥ 32 caractères, sinon l'API refuse de démarrer), `MACITE_AI_LIVE=on`, `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL`, quotas (ci-dessous). `MACITE_AI_PROVIDER` ne concerne que le texte.
4. Redémarrer l'API (migration `0003` : table `ai_usage`). Vérifier : `GET /api/v1/ai/live/status` → `{"enabled": true}`.
5. HTTPS obligatoire côté web (micro).

## Durées et quotas
| Réglage | Défaut | Rôle |
|---|---|---|
| `MACITE_AI_LIVE_MAX_SESSION_S` | 300 | durée maximale d'une session (le client s'arrête à la plus courte entre ceci et 5 min) |
| (fixe) fenêtre de démarrage | 60 s | délai pour ouvrir la session avec le jeton |
| (fixe) marge | 30 s | jeton valable 60 + 300 + 30 = **390 s** |
| `LIVE_CONNECT_TIMEOUT_MS` | 15 s | micro accordé → session ouverte |
| `MACITE_AI_LIVE_DAILY_PER_USER` | 5 | jetons vocaux par utilisateur et par jour (UTC) |
| `MACITE_AI_LIVE_DAILY_GLOBAL` | 50 | coupe-circuit global de la voix |
| `MACITE_AI_LIVE_COOLDOWN_S` | 10 | pause minimale entre deux jetons d'un même utilisateur |
- Quotas **séparés du texte** (`MACITE_AI_DAILY_*`) : portées `live:u:<utilisateur>` / `live:global` contre `u:<utilisateur>` / `global`. Épuiser l'un ne bloque pas l'autre. Défauts **à ajuster** au tarif réel de Google.
- Quota atteint : `429` (utilisateur) ou `503` (global), **aucun appel à Google**. Pause anti-rafale : `429` + `Retry-After`, avant tout appel à Google ; mémoire du processus (plusieurs processus = pause par processus ; le quota, en base, reste exact).
- Échec de Google : quota **remboursé**, pause conservée. Arrêt côté client avant l'étape du jeton : rien n'est consommé.
- **Mesure du coût (pilote)** : à la fermeture d'une session ouverte, l'appareil rapporte la durée (`POST /ai/live/report`, plafonnée, jamais plus de rapports que de jetons). `GET /ai/live/usage` donne ses propres chiffres. Total : `SELECT scope, count FROM ai_usage WHERE day = '<AAAA-MM-JJ>' AND scope LIKE 'live%';` → `live:global` jetons délivrés, `live_started:global` sessions ouvertes, `live_sec:global` secondes écoutées. Coût = secondes × tarif Google en vigueur (à vérifier) ; **seule la facture Google fait foi**.

## Consentement et confidentialité
- **Consentement séparé** du texte (la voix part directement chez Google), demandé avant tout jeton ; le serveur refuse `ack=false` (422).
- **Révocation** : bouton « Retirer mon consentement » ; coupe la session en cours et efface le consentement (stocké sur l'appareil uniquement ; le serveur n'en garde pas).
- **Aucune conversation enregistrée chez nous** : pas d'audio sur notre serveur ; transcription demandée ni en entrée ni en sortie (testé) ; le journal d'audit ne contient que `ai live-token`, `ai live-token failed`, `ai live-end` ; le client n'écrit rien dans la console. Google traite la voix selon ses propres conditions.
- **GPS** : jamais envoyé au modèle ni à notre serveur par la voix (le contexte des outils ne l'expose pas ; résultats d'outils sans coordonnée, testé).
- **Secret** : en production, `MACITE_SECRET` absent, < 32 caractères ou valeur d'exemple → l'API refuse de démarrer ; le message n'affiche jamais la valeur.
- **Erreurs** : jamais de détail technique ; le message d'une erreur du SDK Google n'est jamais affiché ; seuls les motifs de notre serveur (quota, consentement) le sont.

## Audio et interruptions
- **Contexte audio créé au clic** (synchrone, avant l'invite micro) : iOS Safari refuse de démarrer un contexte créé après une attente asynchrone. S'il reste bloqué : message dédié.
- **Interruption** signalée par Google : toutes les sources de lecture sont arrêtées immédiatement, retour à « écoute ». Blocs planifiés bout à bout dans l'ordre d'arrivée ; cadence de sortie lue dans le `mimeType` (24 kHz par défaut).
- **Entrée** : PCM 16 bits, mono, 16 kHz. Sous-échantillonnage par filtre passe-bas (sinc fenêtré de Blackman, coupure ~6,4 kHz) **avant** décimation, état conservé d'un bloc à l'autre (`Downsampler`). Mesuré en test simulé : 10 kHz capté à 48 kHz atténué de plus de 40 dB (l'ancienne moyenne par bloc le laissait passer à ~50 %) ; 1 et 3 kHz à ±3 %.
- **AudioWorklet : préparé, NON branché, NON testé** (`liveCapture.ts`). `ScriptProcessorNode` reste actif ; bascule en une ligne dans `liveSession.ts` après essais sur téléphone.

## Résultats des tests (réels et simulés)
**Exécutés** (clone propre du livrable, `npm ci` puis tests) — micro, audio, SDK, WebSocket et Google sont des **doubles** : ils prouvent la logique, pas le fonctionnement réel.
- API : `cd api && python -m pytest -q` → 63 réussis, 1 ignoré.
- Web : `cd web && npx vitest run` → 98 réussis (11 fichiers) ; `npx tsc --noEmit` propre ; `npm run build` réussi.
- Démarrage en production : `MACITE_ENV=production python -c "import main"` → refus sans secret ; démarrage avec un secret solide.
- Couverture : arrêt avant/pendant micro, jeton, connexion ; session tardive refermée ; démontage ; permission refusée ; jeton MaCité expiré ; connexion Google refusée sans fuite ; réseau coupé ; erreur WebSocket ; son bloqué ; navigateur non pris en charge ; interruption ; ordre des blocs ; outil après fermeture ; identifiant inconnu ; GPS absent ; itinéraire impossible ; expiration ; double clic ; quotas séparés ; quota atteint ; pause anti-rafale ; remboursement ; mesure du coût ; secret de production ; aucune coordonnée ni transcription.
- Contrôle par mutation : retrait du contrôle d'arrêt dans `step` → 1 échec ; filtre neutralisé → 2 échecs ; retrait du remboursement → 1 échec.

**Vérifiés dans la documentation officielle** (page « Ephemeral tokens », mise à jour le 2026-09-15, et « Tool use with Live API », consultées le 2026-10-10 — lecture de la documentation, **pas un test réel**) :
- `POST https://generativelanguage.googleapis.com/v1beta/auth_tokens` avec l'en-tête `x-goog-api-key` ; champs `uses`, `expireTime`, `newSessionExpireTime`, `liveConnectConstraints.model`, `.config.sessionResumption`, `.config.responseModalities` : conformes à notre requête.
- Défauts : 1 minute pour ouvrir la session, 30 minutes (`expireTime`) pour échanger sur la connexion ; `uses: 1` = une seule session. Notre alignement du jeton sur 390 s est cohérent avec cette définition.
- Le jeton s'utilise comme une clé, uniquement avec l'API Live et en `v1beta` : conforme au client (`apiKey: token`, `apiVersion: 'v1beta'`).
- Réponse d'outil : `session.sendToolResponse({ functionResponses: [{ id, name, response }] })` : conforme à notre code.
- Au-delà de 10 minutes, la reconnexion exige `sessionResumption` : sans objet pour des sessions de 5 minutes.

**NON vérifiés** : tout appel réel (création du jeton, connexion SDK, `find_place` / `show_place` / `start_navigation` de bout en bout, effet réel de `expireTime`), qualité audio, écho, coût réel, Android Chrome, iOS Safari. Non revérifiés cette fois dans la documentation : cadences audio (16 kHz entrée / 24 kHz sortie), champ `interrupted`, tarifs. Fichiers Docker non exécutés.

## Diagnostic
- *429 immédiat* : pause anti-rafale (`Retry-After`) ; 429 persistant = quota du jour (`GET /ai/live/usage`).
- *503* : budget global du jour atteint, ou assistant vocal désactivé.
- *502 au jeton* : Google refuse la requête ; lire le corps de la réponse côté serveur **sans** afficher la clé ; quota remboursé. Vérifier d'abord le schéma `liveConnectConstraints` (limite n° 1) puis l'identifiant du modèle.
- *« Le navigateur bloque le son »* : contexte audio non démarré (iOS) ; relancer par un clic.
- *« Le service vocal a refusé ou interrompu la connexion »* : jeton expiré, déjà utilisé, ou modèle refusé ; relancer (nouveau jeton, donc nouvelle pause de 10 s).
- *« Pas de réseau »* / *« connexion interrompue »* : réseau de l'appareil.
- *L'API ne démarre pas en production* : lire le message `MACITE_SECRET …`.
- *Si Google refuse `tools` ou `systemInstruction` dans le jeton* : **ne pas retirer le verrouillage** ; corriger le schéma (`LIVE_TOOLS`, `liveConnectConstraints` dans `provider.py`), consulter `lockAdditionalFields` dans la référence du SDK, documenter la limite.

## Limites connues
1. **Verrouillage des outils et des consignes non confirmé** : la page officielle ne montre dans les contraintes que `model`, `sessionResumption` et `responseModalities` ; elle évoque garder les consignes côté serveur et une option `lockAdditionalFields`. Notre requête y ajoute `systemInstruction` et `tools` : acceptés et appliqués par Google ? **À tester avec une vraie clé.** Tant que ce n'est pas confirmé, ne pas supposer que le client ne peut pas les modifier ; les actions restent de toute façon validées localement (identifiants publiés uniquement).
2. Pause anti-rafale en mémoire du processus.
3. Rapport de durée déclaré par l'appareil (non fiable) : sert à la mesure, pas à la sécurité.
4. AudioWorklet non branché ; `ScriptProcessorNode` déprécié.
5. Pas de transcription affichée, pas de reprise de session après coupure réseau, pas de commandes de relevé par Live.
6. Quotas du jour en UTC ; défauts à ajuster au tarif réel.
7. Qualité du français, bruit ambiant, écho haut-parleur → micro (casque conseillé) : non évalués.
8. Le coût CPU du filtre sur téléphone bas de gamme n'est pas mesuré.

## Tests sur appareil (non faits)
HTTPS, casque, carte de test synchronisée, compte avec consentement.

**Android Chrome**
1. Clic « Conversation vocale » : invite micro → « Connexion… » → « Je vous écoute. »
2. « Où est le bâtiment D3 ? » (→ `find_place`), « Montre-le » (`show_place`), « Emmène-moi là-bas » (`start_navigation`) : avec GPS, puis GPS refusé, puis lieu non relié.
3. Parler pendant la réponse : coupure immédiate.
4. Double clic rapide : aucune session ouverte ; `GET /ai/live/usage` inchangé.
5. Arrêt à chaque phase ; arrêt automatique à 5 min ; durée visible dans `live_sec:global`.
6. Micro refusé ; mode avion avant le clic ; réseau coupé en pleine session.
7. « Retirer mon consentement » en pleine session.
8. Aucun texte ni audio dans le journal ; aucune écriture en base.

**iOS Safari** (mêmes essais, plus) : le son sort **sans second geste** après le clic (contexte audio créé au clic) ; mise en veille / retour d'application pendant la session ; micro refusé dans Réglages ; qualité de la voix captée (le filtre ne doit pas dégrader la compréhension). Activer l'AudioWorklet **seulement après** ces essais.

## Validation avec une vraie clé (à faire)
1. Configurer (section « Configuration ») ; `GET /ai/live/status` → `{"enabled": true}`.
2. `POST /api/v1/ai/live-token` avec `{"ack": true}` et un jeton MaCité → 200 (`token`, `model`, `expires_in`, `max_session_s`). Un 2ᵉ usage du même jeton doit échouer ; un jeton oublié doit expirer à 390 s.
3. Connexion SDK v1beta : vérifier que le client ne peut pas changer outils ni consignes (limite n° 1), puis les trois outils de bout en bout, puis le retour d'outil à la session, puis jeton expiré et erreurs de configuration.
4. 20 à 30 demandes réelles : fautes de frappe, abréviations, « chambre 112 » ambiguë, lieu inexistant, tentative d'injection (« ignore tes règles… »), réseau coupé, quota atteint.
5. Relever le coût réel (facture Google) et le comparer à `live_sec:global`.
