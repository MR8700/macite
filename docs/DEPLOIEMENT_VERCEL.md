# Déploiement complet sur Vercel

Le frontend Vite et l'API FastAPI sont deux projets Vercel, dans le même dépôt (`web` et `api`). PostgreSQL/PostGIS vient de Neon via l'intégration Vercel Marketplace ; les photos sont conservées dans un Vercel Blob privé. Aucun serveur Render, Docker ou disque local n'est requis.

## 1. Projet API FastAPI

Créez un projet Vercel depuis ce dépôt et choisissez `api` comme **Root Directory**. Vercel détecte `main.py`, `requirements.txt` et l'application FastAPI. Python 3.12 est recommandé ; le runtime Python de Vercel est encore indiqué en bêta. Le fichier `api/vercel.json` active Fluid Compute.

Fluid Compute réutilise les instances et réduit les démarrages à froid. Vercel reste une plateforme sans serveur qui peut arrêter puis recréer une instance ; aucun réglage gratuit ne garantit une API toujours chaude. Cela évite le réveil pouvant durer près d'une minute d'un service Render gratuit.

## 2. Base PostgreSQL/PostGIS Neon

Dans le Marketplace de Vercel, ajoutez l'intégration Neon à ce projet API, créez une base PostgreSQL et associez les variables de connexion à Production (et à Preview si nécessaire). Utilisez l'URL pooled fournie dans `DATABASE_URL` pour les fonctions serverless. Le workflow applique la migration Alembic avant le déploiement ; Neon prend en charge PostGIS.

Ajoutez les variables de production suivantes au projet API :

```env
MACITE_ENV=production
MACITE_SECRET=<secret aléatoire de 48 octets ou plus>
MACITE_CORS_ORIGINS=https://<domaine-production-web>
MACITE_RELEVEUR_PASSWORD=<mot de passe fort>
MACITE_EXPERT_PASSWORD=<mot de passe fort>
MACITE_ADMIN_PASSWORD=<mot de passe fort>
MACITE_TRUST_PROXY=1
MACITE_CLIENT_IP_HEADER=x-forwarded-for
MACITE_SKIP_STARTUP_MIGRATIONS=0
MACITE_SITE=kossodo
```

Générez un secret localement avec `python -c "import secrets; print(secrets.token_urlsafe(48))"`, puis collez-le uniquement dans les variables Vercel. Les mots de passe initiaux des comptes sont distincts ; ne partagez et ne versionnez aucune de ces valeurs.

Pour l'assistant Gemini, ajoutez aussi `MACITE_AI_PROVIDER=gemini`, `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-3.5-flash-lite`, `MACITE_AI_LIVE=on` et `GEMINI_LIVE_MODEL=gemini-3.8-live`, plus les quotas `MACITE_AI_*` et `MACITE_AI_LIVE_*` indiqués dans `.env.example`. La clé Gemini déjà partagée doit être renouvelée avant son ajout.

## 3. Photos avec Blob privé

Dans **Storage** du projet Vercel API, créez un Blob **Private** et activez son jeton de lecture/écriture pour l'environnement Production. Vercel ajoute `BLOB_READ_WRITE_TOKEN` au projet. Ne créez pas le Blob sur le projet web : les téléversements et téléchargements passent par l'API, qui vérifie les droits avant d'accéder aux images.

L'offre Hobby de Blob comprend des quotas mensuels gratuits, dont 1 Go de stockage, 10 Go de transfert, 10 000 opérations simples et 2 000 opérations avancées. Si les quotas Hobby sont dépassés, le stockage Blob est suspendu jusqu'à leur renouvellement au lieu de facturer les dépassements. Les photos de l'application sont privées et les réponses sont servies par l'API après authentification. Consultez [les quotas en vigueur](https://vercel.com/docs/vercel-blob/usage-and-pricing).

Avec `MACITE_SKIP_STARTUP_MIGRATIONS=0`, l'instance API applique Alembic au démarrage et crée les comptes initiaux absents depuis les secrets `MACITE_<RÔLE>_PASSWORD`. Vercel ne révèle pas les variables marquées Secret par `vercel env pull` : les migrations ne dépendent donc pas d'une copie locale de `DATABASE_URL`. Le health check après déploiement déclenche le démarrage et vérifie que la base répond. Les démarrages suivants vérifient l'état Alembic avant d'appliquer une migration éventuelle.

## 4. Projet frontend

Créez un second projet Vercel sur le même dépôt, avec **Root Directory** `web`, framework Vite, Node.js 22, `npm ci`, `npm run build` et `dist` en sortie. Définissez en Production :

```env
VITE_API_BASE_URL=https://macite-api.vercel.app/api/v1
```

Cette variable est publique et incorporée au bundle. Ne mettez jamais de secret dans une variable `VITE_*`. Copiez l'origine exacte du site web (schéma `https://`, sans chemin) dans `MACITE_CORS_ORIGINS` sur le projet API.

## 5. Déploiements Git automatisés

Les projets Vercel `macite` (frontend) et `macite-api` (API) sont reliés au dépôt privé `MR8700/maciteapp`, branche `main`. Leurs répertoires racine sont respectivement `web` et `api` ; un push sur cette branche déclenche leur déploiement Vercel. Aucun jeton GitHub Actions n'est nécessaire pour ce flux natif.

Les workflows `.github/workflows/vercel-production.yml` et `.github/workflows/vercel-api-production.yml` restent une alternative manuelle. Ils sont désactivés par défaut et exigent des secrets GitHub dédiés. Ne les activez pas en même temps que les déploiements Git Vercel, afin d'éviter deux déploiements par changement.

## 6. Contrôle après déploiement

- Appelez `https://macite-api.vercel.app/api/v1/health` et vérifiez le résultat `{"status":"ok"}`.
- Depuis le site web final, vérifiez CORS, connexion, recherche, chargement de la carte et relevé.
- Envoyez une photo puis vérifiez sa lecture avec un compte autorisé ; une URL Blob privée seule ne doit pas être accessible sans autorisation.
- Vérifiez les journaux Vercel pour l'initialisation PostgreSQL, les migrations et PostGIS avant d'importer des données réelles.
- Configurez une sauvegarde/export Neon ; Blob et la base sont des stockages séparés.
- Les quotas gratuits sont limités. Lorsque les quotas de Blob ou Neon sont atteints, l'application peut refuser de nouvelles opérations ou requêtes.
- Avant d'ouvrir l'API au public, corrigez les vulnérabilités relevées dans `AUDIT.md` : révocation des anciens jetons après changement/réinitialisation du mot de passe, validation minimale des paramètres `limit`, et réduction de l'énumération des comptes par différences de temps de réponse.

## Références

- [Déployer FastAPI sur Vercel](https://vercel.com/kb/guide/ship-a-fastapi-app-on-vercel)
- [Fluid Compute et démarrages à froid](https://vercel.com/docs/fluid-compute)
- [Postgres sur Vercel et intégrations Marketplace](https://vercel.com/docs/postgres)
- [Stockage privé Vercel Blob](https://vercel.com/docs/vercel-blob/private-storage)
- [Neon : extension PostGIS](https://neon.com/blog/ten-most-popular-postgres-extensions)
