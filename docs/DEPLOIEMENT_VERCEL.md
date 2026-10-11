# Déploiement Vercel du frontend

MaCité comporte deux services. Vercel héberge le frontend Vite (statique) ; l'API FastAPI, PostgreSQL/PostGIS, les photos et les migrations restent sur un serveur Docker avec stockage persistant. Ne déployez pas l'API sur une fonction Vercel : son stockage local et ses migrations au démarrage ne conviennent pas à ce modèle.

## 1. Préparer l'API

Déployez d'abord la pile Docker selon [le guide de déploiement](GUIDE_DEPLOIEMENT.md), avec PostgreSQL/PostGIS, HTTPS et un nom DNS public pour l'API. Vérifiez `https://api.votre-domaine/api/v1/health` et que l'URL `/api/v1` sert bien les routes MaCité. Gardez les secrets uniquement sur le serveur API.

## 2. Créer le projet Vercel

Importez le dépôt Git dans Vercel et réglez le **Root Directory** sur `web` (la configuration `vercel.json` est à cet emplacement). Réglages attendus :

- Framework : Vite
- Install : `npm ci`
- Build : `npm run build`
- Output : `dist`
- Node.js : 22

Ajoutez `VITE_API_BASE_URL` dans les environnements Production, Preview et Development, avec la base de l'API correspondante, par exemple `https://api.votre-domaine/api/v1`. Cette valeur est publique et intégrée au bundle ; n'y placez aucun secret. Les requêtes restent sur cette origine, y compris les envois de photos et la carte hors ligne.

Les imports Git déclenchent ensuite les déploiements Preview pour les PR et Production pour la branche principale. Le workflow GitHub Actions vérifie aussi que `npm ci` et le build réussissent avant la fusion.

## 3. Autoriser le domaine web côté API

Dans l'environnement serveur de l'API, définissez `MACITE_CORS_ORIGINS` comme une liste séparée par des virgules d'origines exactes, sans chemin, par exemple :

```env
MACITE_CORS_ORIGINS=https://carte.votre-domaine,https://macite-web.vercel.app
```

Ajoutez le domaine Vercel de production et votre domaine personnalisé. Pour les Preview, ajoutez les origines Vercel utilisées si elles doivent appeler l'API ; sinon, configurez un environnement API de préproduction distinct. N'utilisez pas `*`. Redémarrez l'API après modification.

La variable `MACITE_TRUST_PROXY=1` ne doit rester activée que si les requêtes vers l'API sont effectivement reçues derrière Caddy (sans accès direct au port API depuis Internet). Vérifiez le pare-feu et le port exposé avant mise en production.

## 4. Vérifications après déploiement

- Ouvrez le domaine HTTPS du frontend et confirmez `/api/v1/health` retourne `{"status":"ok"}` sur le domaine API.
- Essayez la connexion, le chargement de la carte publiée, l'envoi d'un relevé avec photos, puis le téléchargement hors ligne.
- Vérifiez les permissions GPS, caméra et mode hors ligne depuis le domaine HTTPS final.
- Contrôlez les journaux API et Vercel. Une erreur CORS indique le plus souvent que l'origine exacte du frontend manque dans `MACITE_CORS_ORIGINS`.
- Configurez sauvegardes externes et restauration PostgreSQL/photos comme décrit dans le guide Docker. Vercel ne sauvegarde pas ces données.

## Variables par environnement

| Environnement | `VITE_API_BASE_URL` | CORS API |
| --- | --- | --- |
| Développement local (`npm run dev`) | laisser vide, le proxy Vite utilise `http://localhost:8000` | inutile en same-origin via proxy |
| Preview | URL de l'API de préproduction | origine Preview exacte dans la config CORS de cette API |
| Production | URL HTTPS de l'API de production | domaine Vercel de production et domaine personnalisé |

Le service worker est servi sans cache afin que les nouvelles versions du frontend soient prises en compte. Les données cartographiques et relevés déjà enregistrés localement restent gérés par l'application.

## Préparation de sécurité

Avant d'ouvrir le service au public, corrigez et vérifiez les problèmes de sécurité relevés dans `docs/AUDIT.md`, notamment la révocation des sessions après changement de mot de passe, la validation des paramètres `limit` et les différences de temps de réponse permettant l'énumération de comptes. Les migrations PostgreSQL/PostGIS et la chaîne serveur doivent aussi être vérifiées dans l'environnement cible avant d'y importer des données réelles.
