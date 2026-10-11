# Déploiement de production : Render + Vercel

Le dépôt contient un Blueprint Render (`render.yaml`) pour l'API FastAPI, PostgreSQL 16 avec PostGIS et un disque persistant pour les photos. Le frontend React/Vite reste hébergé sur Vercel. Render déploie automatiquement les changements poussés sur `main` après création du Blueprint.

## 1. Créer les ressources Render

1. Poussez le dépôt GitHub `MR8700/macite` sur `main`.
2. Dans Render, ouvrez **New → Blueprint**, connectez GitHub et choisissez ce dépôt. Render détecte `render.yaml` à la racine.
3. Sélectionnez la région Frankfurt si elle est demandée et examinez les ressources/coûts proposés avant de confirmer : l'API et son disque photo utilisent un plan payant, la base PostgreSQL est également une ressource payante.
4. À la première création, renseignez les variables marquées `sync: false` dans Render : `MACITE_CORS_ORIGINS`, les mots de passe initiaux releveur/expert/admin, et `GEMINI_API_KEY`. Ne mettez aucune de ces valeurs dans GitHub ni dans le dépôt. Pour Gemini, utilisez une clé renouvelée : la clé envoyée précédemment dans le chat doit être considérée comme exposée.
5. Render génère `MACITE_SECRET`, relie l'URL PostgreSQL interne, et déploie le conteneur. La migration Alembic active PostGIS au démarrage. Le disque `/app/photos` conserve les fichiers entre les déploiements.

L'API Render utilise `CF-Connecting-IP` pour identifier le client à travers le proxy Render/Cloudflare. N'activez pas le proxy `X-Forwarded-For` générique dans cette configuration.

Après le premier déploiement, vérifiez `https://macite-api.onrender.com/api/v1/health` (l'URL réelle apparaît dans le tableau de bord Render). Si le nom Render est différent, utilisez l'URL affichée par Render partout ci-dessous.

## 2. Relier le frontend Vercel

Créez ou reliez un projet Vercel au dépôt, avec **Root Directory** `web`, framework Vite, Node 22, `npm ci`, `npm run build` et `dist`. Dans les variables de production Vercel, définissez :

```env
VITE_API_BASE_URL=https://<service-api>.onrender.com/api/v1
```

Cette URL est publique et est intégrée au bundle web ; ne mettez aucun secret dans les variables `VITE_*`. Définissez ensuite `MACITE_CORS_ORIGINS` dans Render avec l'origine exacte Vercel (protocole inclus, sans chemin), par exemple `https://macite.vercel.app`. Ajoutez également le domaine personnalisé de production s'il existe. Ne mettez pas `*`.

## 3. Déploiement web automatisé par GitHub Actions

Le workflow `.github/workflows/vercel-production.yml` déploie le frontend après un push `main` touchant `web/**`, ou manuellement depuis l'onglet Actions. Dans les secrets du dépôt GitHub, définissez `VERCEL_TOKEN`, `VERCEL_ORG_ID` et `VERCEL_PROJECT_ID`. Dans **Settings → Secrets and variables → Actions → Variables**, créez `VERCEL_DEPLOY_ENABLED=true` pour activer le workflow.

Dans Vercel, désactivez les déploiements Git automatiques si le workflow CLI est le mécanisme retenu, afin d'éviter un double déploiement. Les variables Vercel `VITE_API_BASE_URL` doivent être configurées avant le build de production.

## 4. Vérifications et contraintes

- Vérifiez l'état de santé API, la connexion, une recherche publique et le chargement de la carte.
- Envoyez une photo, redéployez l'API, puis confirmez que la photo est toujours disponible.
- Vérifiez CORS depuis le domaine final HTTPS, ainsi que GPS, caméra QR et mode hors ligne sur téléphone.
- Configurez et testez une sauvegarde PostgreSQL et des photos hors Render. Le disque persistant n'est pas une sauvegarde.
- Render ne rend pas le volume photo partagé entre plusieurs instances ; le service reste à une instance tant que les fichiers sont stockés sur ce disque.
- Le démarrage de l'API exécute les migrations PostgreSQL ; vérifiez les journaux du premier déploiement avant d'importer les données réelles.
- Les problèmes de sécurité recensés dans `AUDIT.md` doivent être corrigés avant l'ouverture publique de l'API.

## Références de configuration

- [Blueprint Render](https://render.com/docs/blueprint-spec)
- [Extensions PostgreSQL prises en charge (dont PostGIS)](https://render.com/docs/postgresql-extensions)
- [Déploiements Vercel depuis GitHub Actions](https://vercel.com/docs/git/vercel-for-github)
