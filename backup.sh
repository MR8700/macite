#!/bin/sh
# Sauvegarde quotidienne : base + photos. Planification (cron) : 0 2 * * * cd /opt/macite && ./backup.sh
set -e
D="backups"; mkdir -p "$D"; T=$(date +%F)
docker compose exec -T db pg_dump -U macite macite | gzip > "$D/db-$T.sql.gz"
docker compose run --rm -T --no-deps -v "$PWD/$D:/out" api tar czf "/out/photos-$T.tar.gz" -C /app photos
find "$D" -type f -mtime +30 -delete   # conserve 30 jours ; COPIEZ aussi les sauvegardes hors du serveur
