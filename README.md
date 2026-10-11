# MaCité — Ma cité, je m'y retrouve.
PWA de relevé cartographique, recherche et navigation pour la cité universitaire de Kossodo (pilote, CENOU).
Point de départ : maquettes Stitch (`stitch_kossodo_campus_navigator.zip`, écrans HTML/PNG seulement, aucun code applicatif).

## Lancer
```
cd api && pip install -r requirements.txt
export MACITE_SECRET=... MACITE_RELEVEUR_PASSWORD=... MACITE_EXPERT_PASSWORD=...
uvicorn main:app --reload            # http://localhost:8000/docs
cd ../web && npm install && npm run dev
```
Tests : `cd web && npm test` (106) · `cd api && pytest` (78 + 1 ignoré ; sur PostgreSQL lancer chaque fichier séparément : `pytest test_api.py`, `pytest test_ai.py`) · build : `npm run build`.

## Réellement fonctionnel
- Carte MapLibre, position GPS avec précision estimée et seuils configurables (5 m / 15 m, indicatifs).
- Relevés point / chemin / contour : capture GPS ou pose manuelle, filtrage des points redondants, annuler/refaire,
  validation de géométrie (contour auto-sécant, sommets minimum, coordonnées), orientation manuelle N/E/S/O + cap GPS (distinct), orientation du contour calculée.
- Édition des sommets sur la carte : glisser pour déplacer (précision marquée inconnue), double-appui pour supprimer (non testé sur tactile).
- Boussole électronique (iOS et Android) avec indicateur de fiabilité ; le cap du téléphone n’est utilisable comme orientation que s’il est fiable (non testé sur appareil).
- Photos de relevé : capture caméra, réduction (≤1280 px), stockage local, envoi à la synchro (JPEG vérifié par contenu, 2 Mo, 6 max par relevé). Non testé sur téléphone.
- Validation : l’expert voit les photos du relevé (accès protégé par jeton, jamais d’URL publique).
- Administration (rôle admin) : création/désactivation de comptes et changement de rôle (dernier admin protégé, mot de passe ≥ 10 car.), liste des versions de carte avec restauration traçable (une nouvelle version recopie l'ancienne), journal d'audit.
- **Lieux : modèle polymorphe central** (`api/places.py`) : une seule table `places`, un registre de 17 types (bâtiment, aile, étage, chambre, couloir, escalier, ascenseur, porte, entrée, terrain, espace, allée, clôture, service, point d'eau, QR, repère) qui porte les règles : géométries admises, parents admis/obligatoires, niveau d'étage, « praticable » pour la navigation. Ajouter un type = une ligne, sans migration.
- CRUD des lieux (`/api/v1/places`, `/place-types`) : créer, lister/filtrer (type, parent, nom), lire, modifier (version incrémentée), archiver (admin ; refusé s'il reste des enfants actifs). Hiérarchie validée côté serveur (pas de cycle, parent actif). La validation d'un relevé crée le lieu typé ; la publication prend un instantané de tous les lieux actifs ; seuls les chemins allée/couloir/escalier alimentent l'itinéraire (une clôture n'est pas un chemin).
- **Qualité de position** : chaque lieu garde sa provenance (`gps` / `carte` / `estimee`), sa précision et sa date. Un point posé à la main n'est jamais présenté comme GPS. À la validation (et à la création par un admin) : précision maximale (`MACITE_MAX_ACCURACY_M`, 15 m par défaut), lieu contenu dans son parent (`MACITE_CONTAIN_TOL_M`, 8 m), pas de doublon (même type, même parent, même numéro/nom). Dérogation possible par un expert avec motif obligatoire, journalisée.
- **Nouveaux types** : conciergerie, salle d'étude, salle télé, local ménage, salle de conférence, sanitaires, cuisine/buanderie, local technique, infirmerie (dans un bâtiment, avec niveau) et magasin (externe). Un bâtiment peut déclarer qu'un type « n'existe pas » (`declare-absent`).
- **Complétude d'un bâtiment** (`GET /places/{id}/completeness`) : entrée, étages, niveaux manquants, escalier/ascenseur entre niveaux, couloir et pièces par étage, pièces facultatives renseignées ou non.
- **Navigation** : rattachement automatique des chemins à moins de 3 m (écarts et jonctions en T) ; avant, 5 cm d'écart suffisaient à couper le réseau. La publication renvoie des avertissements (blocs isolés, entrées non reliées).
- **Navigation intérieure par niveaux** (`web/src/lib/nav.ts`) : extérieur → entrée → couloirs de chaque étage → escalier/ascenseur → chambre. Les escaliers/ascenseurs sont reliés d'un niveau au suivant quand ils se superposent (≤ 5 m) dans le même bâtiment : il faut donc les enregistrer à CHAQUE étage, au même endroit. Option « sans escalier » (ascenseurs seuls), départ au choix (GPS extérieur ou un lieu connu, utile quand le GPS est inutilisable à l'intérieur), instructions pas à pas, avertissements pour les éléments non reliés. Fonctionne hors ligne (données locales). Testé sur un jeu synthétique : escalier manquant à un étage, entrée manquante, mode sans escalier.
- **Écran « Lieux »** (experts et admins) : arbre bâtiment → étage → pièces avec recherche, provenance et précision de position de chaque lieu (badge d'alerte si position pointée/estimée ou imprécise), « Voir » sur la carte, renommer, archiver (admin), et pour chaque bâtiment la **complétude** (problèmes détectés, pièces facultatives présentes / « n'existe pas » / non renseignées, avec boutons de déclaration).
- **PostgreSQL + PostGIS + Alembic** (testé sur PostgreSQL 16 / PostGIS 3.4) : migrations versionnées (`api/migrations`, `0001` schéma, `0002` PostGIS), colonne `places.geom geometry(Geometry,4326)` remplie par un trigger depuis les points, index spatial GiST, contrainte `ST_IsValid` (la base refuse un contour qui se croise ; l'API le refuse d'abord en 422), recherche « lieux à proximité » via `ST_DWithin`. Sur PostgreSQL l'API applique les migrations au démarrage ; sur SQLite (dev rapide) elle crée les tables directement.
- **Recalage par QR** : QR imprimables par lieu « Repère QR » (écran Lieux), scan caméra (navigateurs avec `BarcodeDetector`, sinon saisie manuelle) ; le contenu est strictement validé (`macite://p/<id>`, jamais une URL externe) ; le lieu scanné devient le point de départ de l'itinéraire, à son niveau. Le scan caméra n'est pas testable ici (testé : lecture/validation du contenu, génération, départ depuis un QR).
- **Assistant IA (Google AI Studio)** : recherche en langage naturel, itinéraire, brouillon de fiche de relevé depuis une description (texte ou dictée du navigateur), commandes vocales fermées. Désactivé par défaut ; le modèle choisit parmi les lieux publiés, quotas par utilisateur et globaux, repli sans IA, consentement explicite. Conversation vocale Gemini Live (jeton éphémère, quotas séparés, consentement révocable, outils de navigation) : désactivée par défaut ; en production, l'API refuse de démarrer sans `MACITE_SECRET` solide (`MACITE_ENV=production`). Voir `docs/ASSISTANT_IA.md`. **Non testé avec une vraie clé ni sur téléphone.**
- **Guide de relevé terrain** : `docs/GUIDE_RELEVE_TERRAIN.md`.
- **Trajets par niveau** : le trajet est découpé en tronçons (extérieur, niveau 0, 1, 2…) ; des boutons choisissent le niveau affiché sur la carte (les autres s'estompent).
- **Sécurité** : jetons signés à expiration (12 h), blocage après 5 échecs de connexion, `/api/v1/health` pour la supervision, HTTPS automatique via Caddy (Docker, non testé ici). Voir `docs/GUIDE_DEPLOIEMENT.md`.
- Brouillons persistés (IndexedDB), reprise, statuts, file d'envoi, conflit de version signalé sans écrasement.
- API : login, sync, validation/rejet (motif obligatoire), publication de versions immuables, droits côté serveur, journal d'audit.
- Recherche locale des lieux publiés, itinéraire Dijkstra sur chemins publiés (message si aucun chemin).
- PWA : application mise en cache (service worker), données publiées stockées localement.

## À faire / limites
- HTTPS et sauvegardes automatisées en production ; les fichiers Docker restent non testés.
- Fond de carte hors ligne : voir ci-dessous (le fichier est à produire par vos soins).
- plan intérieur, QR de recalage, résolution de conflit guidée, administration (comptes, cités), polices Manrope/Inter locales.
- **Pas encore : tests sur téléphones réels**. Pas de création/édition complète d'un lieu depuis l'écran « Lieux » (renommer et archiver seulement ; le reste passe par un relevé ou l'API), pas de changement de type d'un lieu (archiver puis recréer), pas de déplacement d'un lieu entre cités, relevé d'un lieu existant à corriger non branché. Aucun test sur téléphone réel ; aucune donnée réelle de Kossodo n'est incluse (la carte démarre vide).

## Déploiement (Docker, NON TESTÉ ici)
`cp .env.example .env`, renseigner les valeurs, `docker compose up --build`, puis ouvrir http://localhost:8080.
Ajouter un reverse proxy HTTPS en production. `backup.sh` fait la sauvegarde PostgreSQL. Les fichiers Docker n'ont pas pu être exécutés dans mon environnement : à vérifier au premier lancement.

## Fond de carte hors ligne
- En ligne : fond OpenStreetMap (© contributeurs OSM). **On ne télécharge pas ses tuiles en masse** (interdit par sa politique d'usage).
- Hors ligne : l'appli télécharge un fichier **PMTiles raster** (PNG/JPG/WebP) servi par VOTRE serveur à `/api/v1/sites/kossodo/offline-map` (fichier `tiles/kossodo.pmtiles`, ou `OFFLINE_MAP_PATH`), le stocke dans IndexedDB et l'utilise sans réseau (zooms couverts seulement).
- **Outil fourni : `tools/make_basemap.py`** (voir `docs/FOND_DE_CARTE_HORS_LIGNE.md`) : génère le PMTiles depuis vos relevés publiés (`--api`) et/ou un GeoJSON OpenStreetMap (`--source osm`, attribution ODbL automatique et affichée), sans jamais copier de tuiles tierces. **Le fichier réel de Kossodo n'est pas fourni** : il reste à le générer. Ancienne note : un fichier de la zone de la cité depuis une source dont la licence l'autorise (imagerie dont vous avez les droits, rendu de vos propres données, serveur de tuiles auto-hébergé) puis conversion en PMTiles (outil `pmtiles` / `go-pmtiles`). Aucun fichier de ce type n'est fourni ici ; seul un fichier de test synthétique sert aux tests.
- Limites : raster uniquement (pas de vecteur), pas encore de mise à jour partielle, non testé sur téléphone ni en vrai mode avion.

Migrations : `cd api && DATABASE_URL=postgresql+psycopg://... alembic upgrade head`. Tests sur PostgreSQL : `TEST_DATABASE_URL=postgresql+psycopg://... pytest` (ATTENTION : vide le schéma `public` de cette base, à utiliser sur une base de test).

## Audit et corrections (lots 2, 5, 6, 7)
Rapport complet : `docs/AUDIT.md` (défauts corrigés, défauts constatés mais non corrigés, limites). Nouveaux tests : `api/test_audit_fixes.py`, `web/src/lib/auditFixes.test.ts`.

## Frontend Vercel
Le frontend Vite peut etre deploye sur Vercel, tandis que l'API, PostgreSQL/PostGIS et les photos restent sur le serveur Docker. Consultez [docs/DEPLOIEMENT_VERCEL.md](docs/DEPLOIEMENT_VERCEL.md) pour configurer le projet, l'URL de l'API, CORS et les deploiements Git automatiques.
