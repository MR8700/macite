# Déploiement du frontend sur Vercel

Le frontend Vite est construit depuis le dossier `web`. L'API, PostgreSQL/PostGIS et le stockage photo sont hébergés sur Render ; suivre [le guide Render + Vercel](DEPLOIEMENT_RENDER.md) pour créer les services et configurer CORS.

Réglages Vercel : Root Directory `web`, framework Vite, Node.js 22, commande d'installation `npm ci`, commande de build `npm run build`, dossier de sortie `dist`.

Définir `VITE_API_BASE_URL` en Production sur `https://<service-api>.onrender.com/api/v1` (remplacer par l'URL réelle affichée par Render). Cette variable est publique et intégrée au bundle. Aucun secret ne doit avoir le préfixe `VITE_`.

Le workflow GitHub Actions `.github/workflows/vercel-production.yml` automatise le déploiement de `main`. Il nécessite les secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID` et `VERCEL_PROJECT_ID`, ainsi que la variable GitHub `VERCEL_DEPLOY_ENABLED=true`. Désactivez les déploiements Git automatiques Vercel si vous choisissez cette méthode pour éviter les builds en double.
