# Guide de déploiement — MaCité

> Statut : la pile (API + PostgreSQL/PostGIS + migrations) est testée ; **les fichiers Docker/Caddy n'ont pas pu être exécutés dans l'environnement de développement** : faites le premier déploiement sur un serveur de test.

## Prérequis
- Serveur Linux (2 Go RAM suffisent pour une cité), Docker + Docker Compose, ports 80 et 443 ouverts.
- Un nom de domaine pointant vers le serveur (enregistrement DNS A) : nécessaire pour le HTTPS, et **obligatoire** pour le GPS, la caméra et le mode hors ligne (les navigateurs les exigent en HTTPS).

## Installation
1. `cp .env.example .env` puis renseignez : `POSTGRES_PASSWORD`, `MACITE_SECRET` (longue valeur aléatoire : `openssl rand -hex 32`), `MACITE_RELEVEUR_PASSWORD`, `MACITE_EXPERT_PASSWORD`, `MACITE_ADMIN_PASSWORD`, `MACITE_DOMAIN`. **Ne versionnez jamais `.env`.**
2. Facultatif : placez le fond de carte hors ligne dans `tiles/kossodo.pmtiles` (voir README).
3. `docker compose up -d --build` : les migrations s'appliquent seules au démarrage de l'API ; Caddy obtient le certificat HTTPS.
4. Vérifiez : `https://<domaine>/api/v1/health` → `{"status":"ok"}` ; ouvrez `https://<domaine>`, connectez-vous (onglet Synchro) avec le compte admin, puis **créez de vrais comptes nominatifs** (onglet Admin) et changez/retirez les mots de passe initiaux.
5. Les comptes `releveur`/`expert`/`admin` initiaux ne sont créés que si leur variable est définie, et seulement s'ils n'existent pas.

## Sauvegardes et restauration
- `./backup.sh` (base + photos, 30 jours conservés) : planifiez-le avec cron, et **copiez les sauvegardes hors du serveur**.
- **Testez la restauration avant d'en avoir besoin** : sur un serveur de test, `gunzip -c backups/db-AAAA-MM-JJ.sql.gz | docker compose exec -T db psql -U macite macite` (base vide), puis `tar xzf backups/photos-….tar.gz` dans le volume des photos.

## Mise à jour
`git pull` (ou nouveau zip) → `docker compose up -d --build`. Les migrations sont appliquées automatiquement ; faites une sauvegarde avant.

## Exploitation
- Journaux : `docker compose logs -f api`. Le journal d'audit applicatif (qui a validé/publié/archivé quoi) est consultable dans l'onglet Admin.
- Supervision : interrogez `/api/v1/health` (503 si la base est injoignable) avec un outil de surveillance externe.
- Sécurité : HTTPS seul, mots de passe ≥ 10 caractères, désactivez les comptes des personnes parties, ne laissez qu'un petit nombre d'admins. Les jetons de session sont signés et expirent ; changer `MACITE_SECRET` déconnecte tout le monde.

## Limites connues (à traiter avant un usage à grande échelle)
- Limitation des essais de connexion : 5 échecs par couple (adresse, identifiant) en 5 min, plafond de 30 échecs par adresse ; compteurs **en base** (table `login_fails`, migration `0004`) : valables avec plusieurs instances de l'API et après redémarrage. Derrière Caddy, laissez `MACITE_TRUST_PROXY=1` ; ne l'activez jamais si l'API est joignable directement.
- Jetons valables 12 h (`MACITE_TOKEN_TTL_H`) ; pas de révocation individuelle avant expiration (désactiver un compte bloque son accès immédiatement ; changer `MACITE_SECRET` invalide tous les jetons).
- Aucun test de charge ; dimensionné pour une cité (quelques centaines de lieux, dizaines d'utilisateurs).
