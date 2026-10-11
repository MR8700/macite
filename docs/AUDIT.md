# Audit MaCité — lots 2, 5, 6, 7

Périmètre lu en détail : toute l'API (`main.py`, `places.py`, `security.py`, `macite_ai/*`), et côté web `App.tsx`, `SurveyPanel`, `AiDescribe`, `AssistantPanel`, `PlacesPanel`, `AdminPanel`, `ReviewPhotos`, `sync.ts`, `db.ts`, `graph.ts`, `nav.ts`, `itinerary.ts`, `fuzzy.ts`, `geo.ts`, `aiClient.ts`, `liveTools.ts`, `voice.ts`, `placeTypes.ts`, `useGps.ts`, `photo.ts`.
**Parcourus seulement par leurs tests, pas relus ligne à ligne** : `liveSession.ts`, `liveAudio.ts`, `MapView.tsx`, `QrScanner.tsx`, `offlineMap.ts`, `compass.ts`, `tools/make_basemap.py`, migrations Alembic, Docker/Caddy.

Référence avant corrections : API 63 tests, web 98 tests, `tsc` propre. Après lot A : API 78 (+1 ignoré), web 106 ; après lot B : API 90 (+1 ignoré), web 108, `tsc` et `vite build` propres.
Tout a été exécuté sur SQLite. **Le chemin PostgreSQL/PostGIS (dont la restauration du rollback) n'a pas été exécuté.**

---

## A. Corrigé (avec test)

### Fonctionnalités inabouties
| # | Défaut | Correction |
|---|---|---|
| 1 | **Le releveur ne savait jamais qu'un relevé était validé, publié ou rejeté** : aucun code client ne mettait à jour le statut ; le bouton « Reprendre » pour `a_corriger` était inatteignable ; le motif de rejet n'était jamais renvoyé par l'API (`dump`). | L'API renvoie `reject_reason` ; `pullSurveyStatuses` rapatrie statut + motif à chaque synchro (sans écraser une modification locale) ; le motif s'affiche dans « Synchro ». |
| 2 | **Resoumission impossible après correction** : le serveur incrémente la version, le client gardait l'ancienne → conflit permanent. | Le serveur renvoie `version` dans la réponse de `/sync`, le client la reprend ; une correction soumise efface l'ancien motif. |
| 3 | **Retour arrière (rollback) cosmétique** : une nouvelle version recopiait l'ancienne, mais la table de travail `places` gardait l'état d'après. La publication suivante republiait aussitôt les lieux annulés. | `restore_working_places` remet `places` dans l'état de l'instantané (archive les ajouts, restaure noms/géométries/versions) ; la publication suivante répond « Rien de nouveau ». |
| 4 | `graph.warnings` (éléments non reliés) calculé mais **jamais affiché**, alors que le README l'annonce. | Affiché aux experts/admins sous l'itinéraire. |
| 5 | Photos : un refus définitif du serveur (413/415/409/422) était réessayé à chaque synchro, en silence. | Marqué `error`, compté (`photoErrors`), affiché ; erreurs passagères réessayées ; réseau coupé = arrêt de la boucle. |

### Bugs
| # | Défaut | Correction |
|---|---|---|
| 6 | **Écran blanc** : session expirée dans « Valider » → `reviewApi.list` renvoyait `{detail}` puis `queue.map` plantait. | Erreur claire `SESSION_EXPIRED`, déconnexion propre, résultat toujours un tableau. |
| 7 | « précision min **Infinity** m » pour un relevé sans GPS ; et on affichait le *meilleur* point alors que la règle de validation juge le *pire*. | Affiche le pire point, ou « précision inconnue ». |
| 8 | Valider/Corriger/Publier : erreurs (rejet, 403, 500, réseau) **silencieuses** ; `status` partagé entre « Synchro » et « Valider ». | Gestionnaires nommés avec messages ; deux états distincts. |
| 9 | `useGps` : après refus de permission, « Activer » restait sans effet (la veille morte gardait `w.current`). | Veille libérée au refus. |
| 10 | Course entre deux recherches : une réponse tardive écrasait la dernière frappe. | Annulation par drapeau dans l'effet. |
| 11 | `localStorage` corrompu → `JSON.parse` plante au démarrage. | `readAuth` tolérant. |
| 12 | `PATCH /places` sans validation des coordonnées (le `POST` en avait), `number`/`description` sans limite, renommage en **doublon** accepté, champ mort `set_parent`. | Mêmes garde-fous que `POST` ; doublon → 409 (renommage seul : sans contrôle de géométrie). |
| 13 | Types « à niveau » (étage, chambre, couloir, escalier, porte, QR, pièces…) acceptés **sans niveau** ; la navigation les plaçait silencieusement au RDC (`level ?? 0`). | Niveau obligatoire côté serveur (`validate_place`) et côté client avant soumission. |
| 14 | Publication annonçait « réseau connecté » dès qu'un *sommet quelconque* frôlait un autre chemin, alors que le client ne rattache que les **extrémités**. Itinéraire introuvable malgré un avertissement vert. | `connectivity_warnings` utilise la même règle que `snapPaths`. |
| 15 | Pagination de `/surveys` sans `ORDER BY` (non déterministe), `limit` négatif accepté. | Tri stable, bornes `Query(ge=1, le=200)` (idem `/places`). |
| 16 | Photo : condition de validation d'identifiant redondante (longueur illimitée) ; un identifiant déjà pris par *un autre relevé* répondait `duplicate`. | Validation 1–64 caractères ; collision inter-relevés → 409. |
| 17 | `_FAILS` (verrou de connexion) grossissait sans limite avec des identifiants inventés. | Purge des entrées expirées au-delà de 1000. |
| 18 | `MACITE_AI_PROVIDER=fake` autorisé en production (échoue toujours → assistant « dégradé » en permanence). | Refusé en production. |

### Gestion de quota (IA)
| # | Défaut | Correction |
|---|---|---|
| 19 | **Défauts du code ≠ documentation** : 50/utilisateur et **2000 global** dans le code ; `.env.example` dit 20 et 400 (et l'offre gratuite Google ≈ 500/jour/projet). Sans variable d'environnement, le coupe-circuit ne protégeait rien. | Défauts alignés : 20 / 400. |
| 20 | Texte (`/ai/chat`, `/ai/survey-draft`) : une panne de Google **consommait quand même** le quota de l'utilisateur, alors que la voix remboursait. | Remboursement si le fournisseur n'a pas répondu ; une réponse reçue mais inutilisable reste comptée. |
| 21 | Un message sans mot exploitable (« le la ?! ») appelait quand même le modèle. | Réponse `not_found` sans appel ni décompte. |
| 22 | L'utilisateur découvrait son quota par un 429. | `GET /ai/usage` ; compteur « Requêtes IA restantes » ; une fois à 0, plus aucun appel serveur (recherche locale directe). |
| 23 | Chaque question, même « bâtiment D3 », coûtait une requête. | `confidentLocalMatch` : désignation sans ambiguïté → réponse locale. Jamais pour un trajet, une catégorie, un doute ou un chiffre qui ne correspond pas (D3 ≠ D4). |

### Redondances
- `("releveur","expert","admin")` répété 5 fois dans `Depends(need(...))`, + `ROLES` / `ROLES_INIT` / deux `Literal` identiques → `ROLES`, `Role`, `ANY_USER`.
- `db.get(Place, parent_id)` appelé trois fois dans `sync` → une fois.
- `validateGeometry` appelé deux fois dans `save`.
- Deux classes `SurveyIn` homonymes (relevé complet / texte IA) → la seconde renommée `SurveyTextIn`.
- Docstring de `main.py` disant que PostGIS « reste À FAIRE » (c'est fait).
- **Miroir `placeTypes.ts` ↔ `places.py`** (copie manuelle) : vérifié identique ; un test échoue désormais si l'un dérive.

---

## B. Constaté — état après le lot B (10/10/2026)

**Corrigé (avec test)**
- `hpw` : **sel aléatoire par compte** (format `pbkdf2$sel$empreinte`). Les anciennes empreintes restent acceptées et sont **migrées automatiquement à la première connexion** ; plus de dépendance à `MACITE_SECRET` pour les mots de passe.
- Aucun changement de mot de passe : ajout de `POST /api/v1/auth/password` (mot de passe actuel requis, ≥ 10 car.) et `POST /api/v1/admin/users/{name}/password` (réinitialisation par un admin, lève aussi le verrou de connexion).
- `/api/v1/search` public : **limitation par client** (`MACITE_SEARCH_PER_MIN`, 60 par défaut), 429 au-delà.
- `GET /sites/{site}/map` : site inconnu → 404 (`MACITE_SITE`, `kossodo` par défaut) ; tests alignés.
- `pos_source` : plus de valeur `gps+carte` ; un relevé à GPS partiel est enregistré « carte » (contrat `gps | carte | estimee` respecté).
- Photo sur relevé déjà validé/publié : refusée (409).
- `pullSurveyStatuses` : lit désormais **toutes les pages** (200 par page).
- `@app.on_event("startup")` remplacé par `lifespan`.

**Corrigé au second passage**
- Verrou de connexion : désormais **en base** (table `login_fails`, migration `0004` : partagé entre workers, survit au redémarrage) et par couple **(adresse, identifiant)** + plafond d'échecs par adresse (`MACITE_LOGIN_MAX_FAILS_PER_IP`, 30). Un tiers ne bloque plus le compte d'un autre depuis sa propre adresse. Derrière Caddy, mettre `MACITE_TRUST_PROXY=1` (l'adresse est lue dans la dernière valeur de `X-Forwarded-For`, posée par Caddy ; `nginx.conf` la transmet telle quelle au lieu de la remplacer par l'adresse de Caddy — **chaîne Caddy → nginx → API à vérifier en préproduction**). Sans cette variable, l'en-tête est ignoré.
- Comptes issus des variables d'environnement : option `MACITE_SYNC_ENV_PASSWORDS=1` pour que la variable redevienne la référence au démarrage (désactivée par défaut, pour ne pas écraser un mot de passe changé par l'utilisateur).
- `graph.ts` : `buildGraph` / `nearestNode` supprimés ; `geo.test.ts` porté sur `buildNavGraph` + `locateXY` (un seul graphe).
- Dijkstra : file de priorité à **tas binaire** (+ test).
- « category » **supprimé** (au lieu d'être seulement documenté) : relevé = `place_type` (le code, côté web `placeType`) ; lieu publié = `type` (code) + `type_label` (libellé, toujours **dérivé** du code par le serveur, donc rien à migrer dans les anciens instantanés de carte). Migration IndexedDB v4 sur les téléphones (testée : relevés et lieux publiés conservés) ; migration Alembic `0004` supprime `surveys.category` après avoir complété `place_type` si besoin (testée sur SQLite, **pas sur PostgreSQL**). L'API accepte encore un `category` envoyé par une ancienne application (ignoré) et renvoie `category` en alias de `type_label` dans `/sites/{site}/map` pour les applications installées avant la mise à jour — **à retirer** une fois toutes les applications mises à jour.

**Trouvé et corrigé en relisant mes propres changements**
- **Traversée de répertoire** : l'identifiant d'un relevé servait de nom de dossier pour les photos sans aucune restriction ; un relevé nommé `..` permettait d'écrire un fichier JPEG hors du dossier des photos (reproduit). Identifiant limité à `[A-Za-z0-9_-]{1,64}` + contrôle au moment de l'envoi de la photo (anciens relevés).
- Limitation de `/search` : elle utilisait l'adresse du proxy, donc tous les visiteurs partageaient les mêmes 60 requêtes/minute en production. Elle utilise maintenant l'adresse réelle (`client_ip`).

**Reste à faire**
- Une limitation Caddy (`rate_limit`, plugin à compiler) reste un bon complément pour la recherche publique ; non testable ici.
- Retirer l'alias `category` de `/sites/{site}/map` (voir ci-dessus) quand les applications sont à jour.
- Anciens lieux déjà validés avec `pos_source = gps+carte` : toujours en base (inoffensif ; affichés « pointée »).

**Non vérifiable ici** : Docker/Caddy, PostgreSQL/PostGIS (dont la restauration du rollback), vraie clé Gemini, téléphones réels, GPS/boussole/QR caméra.

---

## C. Changements de comportement à connaître
1. **Niveau obligatoire** : un lieu « à niveau » déjà enregistré sans niveau ne pourra plus être modifié (même renommé) avant qu'on lui donne un niveau. Le README précise que la carte démarre vide ; à vérifier si des données existent.
2. **Réponse locale de l'assistant** : « bâtiment D3 » ne passe plus par le modèle ; le message indique « Réponse locale ».
3. **Avertissements de publication** plus stricts (extrémités seulement) : ils peuvent apparaître là où l'ancien test restait muet — c'est le comportement réel de l'application.
4. **Rollback** : les lieux absents de l'instantané sont archivés dans la table de travail (historique conservé).
