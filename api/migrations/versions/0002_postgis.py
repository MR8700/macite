"""PostGIS : colonne géométrique + index GiST sur places (PostgreSQL uniquement ; sans effet sur SQLite).

La source de vérité applicative reste `points` (JSON). `geom` en est dérivée par un TRIGGER : tout écrivain
(API, script, SQL manuel) garde donc geom cohérente. Une géométrie invalide (ex. contour qui se croise) est refusée par la base.
"""
from alembic import op

revision = "0002"; down_revision = "0001"; branch_labels = None; depends_on = None

FN = """
CREATE OR REPLACE FUNCTION places_sync_geom() RETURNS trigger AS $$
DECLARE pts jsonb := NEW.points::jsonb;
BEGIN
  IF jsonb_array_length(pts) = 0 THEN NEW.geom := NULL; RETURN NEW; END IF;
  IF NEW.kind = 'point' THEN
    NEW.geom := ST_SetSRID(ST_GeomFromGeoJSON(jsonb_build_object('type','Point','coordinates',pts->0)::text), 4326);
  ELSIF NEW.kind = 'path' THEN
    NEW.geom := ST_SetSRID(ST_GeomFromGeoJSON(jsonb_build_object('type','LineString','coordinates',pts)::text), 4326);
  ELSE
    NEW.geom := ST_SetSRID(ST_GeomFromGeoJSON(jsonb_build_object('type','Polygon','coordinates',jsonb_build_array(pts || jsonb_build_array(pts->0)))::text), 4326);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
"""

def upgrade():
    if op.get_bind().dialect.name != "postgresql": return
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.execute("ALTER TABLE places ADD COLUMN geom geometry(Geometry, 4326)")
    op.execute(FN)
    op.execute("CREATE TRIGGER places_geom_trg BEFORE INSERT OR UPDATE OF points, kind ON places FOR EACH ROW EXECUTE FUNCTION places_sync_geom()")
    op.execute("UPDATE places SET points = points")  # recalcule geom pour les lignes existantes
    op.execute("ALTER TABLE places ADD CONSTRAINT places_geom_valid CHECK (geom IS NULL OR ST_IsValid(geom))")
    op.execute("CREATE INDEX ix_places_geom ON places USING GIST (geom)")

def downgrade():
    if op.get_bind().dialect.name != "postgresql": return
    op.execute("DROP TRIGGER IF EXISTS places_geom_trg ON places"); op.execute("DROP FUNCTION IF EXISTS places_sync_geom()")
    op.execute("DROP INDEX IF EXISTS ix_places_geom"); op.execute("ALTER TABLE places DROP CONSTRAINT IF EXISTS places_geom_valid"); op.execute("ALTER TABLE places DROP COLUMN IF EXISTS geom")
