#!/usr/bin/env python3
"""Génère le fond de carte hors ligne (PMTiles raster PNG) de MaCité à partir de DONNÉES VECTORIELLES dont vous avez le droit.

Sources acceptées (aucune tuile n'est jamais téléchargée depuis un serveur de cartes tiers) :
  --api URL      la carte PUBLIÉE de MaCité (vos propres relevés)          -> licence : vos données
  --geojson F    un GeoJSON (ex. extrait OpenStreetMap exporté par vos soins) -> --source osm impose la mention © OpenStreetMap (ODbL)
Usage :  python make_basemap.py --api https://carte.exemple.bf --out ../tiles/kossodo.pmtiles
         python make_basemap.py --geojson extrait_osm.geojson --source osm --out ../tiles/kossodo.pmtiles
"""
import argparse, io, json, math, sys, urllib.request
from PIL import Image, ImageDraw
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write

BG = (246, 248, 247)
STYLE = {  # type MaCité -> (remplissage, contour) ; clés OSM reconnues via osm_type()
    "batiment": ((200, 210, 222), (120, 135, 155)), "terrain": ((190, 225, 190), (90, 150, 90)), "espace": ((222, 236, 214), (150, 180, 140)),
    "magasin": ((236, 214, 196), (170, 130, 100)), "cloture": (None, (150, 150, 150)), "allee": (None, (255, 255, 255)),
}
ROAD_CASING = (190, 196, 200)

def lonlat_to_px(lon, lat, z):
    n = 256 * 2 ** z; x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y

def osm_type(props):
    if props.get("building"): return "batiment"
    if props.get("leisure") in ("pitch", "sports_centre", "stadium"): return "terrain"
    if props.get("landuse") or props.get("leisure") or props.get("amenity") == "parking": return "espace"
    if props.get("shop"): return "magasin"
    if props.get("highway") in ("footway", "path", "pedestrian", "service", "residential", "track", "living_street", "unclassified", "tertiary", "secondary", "primary"): return "allee"
    if props.get("barrier") in ("fence", "wall"): return "cloture"
    return props.get("type") if props.get("type") in STYLE else None

def load_features(args):
    """-> liste de (type, 'polygon'|'path'|'point', [[lon,lat],...])"""
    out = []
    if args.api:
        d = json.load(urllib.request.urlopen(args.api.rstrip("/") + "/api/v1/sites/kossodo/map", timeout=30))
        for p in d["places"]:
            if p.get("type") in STYLE or p["kind"] != "point": out.append((p.get("type") or "espace", p["kind"], p["points"]))
    for f in args.geojson or []:
        for ft in json.load(open(f))["features"]:
            g, pr = ft["geometry"], ft.get("properties") or {}; t = osm_type(pr)
            if not t: continue
            if g["type"] == "Polygon": out.append((t, "polygon", g["coordinates"][0][:-1]))
            elif g["type"] == "MultiPolygon": out += [(t, "polygon", poly[0][:-1]) for poly in g["coordinates"]]
            elif g["type"] == "LineString": out.append((t, "path", g["coordinates"]))
            elif g["type"] == "Point": out.append((t, "point", [g["coordinates"]]))
    return out

def render_tile(feats, z, tx, ty, S=2):
    size = 256 * S; im = Image.new("RGB", (size, size), BG); d = ImageDraw.Draw(im); ox, oy = tx * 256, ty * 256
    proj = lambda pts: [((x - ox) * S, (y - oy) * S) for x, y in (lonlat_to_px(p[0], p[1], z) for p in pts)]
    w = max(1, (z - 13)) * S  # largeur des routes qui croît avec le zoom
    order = {"espace": 0, "terrain": 1, "batiment": 2, "magasin": 2, "cloture": 3, "allee": 4}
    drawn = False
    for t, kind, pts in sorted(feats, key=lambda f: order.get(f[0], 3)):
        fill, line = STYLE.get(t, ((225, 225, 225), (140, 140, 140))); P = proj(pts)
        if not any(-50 < x < size + 50 and -50 < y < size + 50 for x, y in P) and kind != "path": continue
        if kind == "polygon" and len(P) >= 3: d.polygon(P, fill=fill or BG, outline=line, width=S); drawn = True
        elif kind == "path" and len(P) >= 2:
            if t == "allee": d.line(P, fill=ROAD_CASING, width=w + 2 * S, joint="curve"); d.line(P, fill=line, width=w, joint="curve")
            else: d.line(P, fill=line, width=S, joint="curve")
            drawn = True
        elif kind == "point": r = 3 * S; d.ellipse([P[0][0] - r, P[0][1] - r, P[0][0] + r, P[0][1] + r], fill=(22, 132, 91), outline=(255, 255, 255)); drawn = True
    return (im.resize((256, 256), Image.LANCZOS), drawn)

def tiles_for_bbox(b, z):
    x0, y0 = lonlat_to_px(b[0], b[3], z); x1, y1 = lonlat_to_px(b[2], b[1], z)
    return [(x, y) for x in range(int(x0 // 256), int(x1 // 256) + 1) for y in range(int(y0 // 256), int(y1 // 256) + 1)]

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api"); ap.add_argument("--geojson", action="append"); ap.add_argument("--out", required=True)
    ap.add_argument("--source", choices=["own", "osm"], default="own"); ap.add_argument("--minzoom", type=int, default=15); ap.add_argument("--maxzoom", type=int, default=19)
    ap.add_argument("--margin-m", type=float, default=150); ap.add_argument("--max-tiles", type=int, default=20000)
    a = ap.parse_args(argv)
    if not a.api and not a.geojson: ap.error("fournir --api et/ou --geojson")
    if a.geojson and a.source != "osm" and not a.api: print("Info : GeoJSON fourni sans --source osm : assurez-vous d'en détenir les droits.", file=sys.stderr)
    feats = load_features(a)
    if not feats: sys.exit("Aucune donnée à dessiner : ne produisez pas de fond de carte vide.")
    pts = [p for _, _, ps in feats for p in ps]; m = a.margin_m / 111320
    b = (min(p[0] for p in pts) - m, min(p[1] for p in pts) - m, max(p[0] for p in pts) + m, max(p[1] for p in pts) + m)
    total = sum(len(tiles_for_bbox(b, z)) for z in range(a.minzoom, a.maxzoom + 1))
    if total > a.max_tiles: sys.exit(f"{total} tuiles > --max-tiles {a.max_tiles} : réduisez la zone ou le zoom maximal.")
    attribution = ("© contributeurs OpenStreetMap (ODbL), rendu MaCité" if a.source == "osm" else "Données MaCité / CENOU") + (" + données MaCité" if a.source == "osm" and a.api else "")
    n = 0
    with write(a.out) as w:
        for z in range(a.minzoom, a.maxzoom + 1):
            for x, y in sorted(tiles_for_bbox(b, z), key=lambda t: zxy_to_tileid(z, *t)):
                im, drawn = render_tile(feats, z, x, y)
                if not drawn: continue  # pas de tuile vide : économise de la place
                buf = io.BytesIO(); im.save(buf, "PNG", optimize=True); w.write_tile(zxy_to_tileid(z, x, y), buf.getvalue()); n += 1
        e7 = lambda v: int(round(v * 1e7))
        w.finalize({"tile_type": TileType.PNG, "tile_compression": Compression.NONE, "min_zoom": a.minzoom, "max_zoom": a.maxzoom,
                    "min_lon_e7": e7(b[0]), "min_lat_e7": e7(b[1]), "max_lon_e7": e7(b[2]), "max_lat_e7": e7(b[3]),
                    "center_zoom": (a.minzoom + a.maxzoom) // 2, "center_lon_e7": e7((b[0] + b[2]) / 2), "center_lat_e7": e7((b[1] + b[3]) / 2)},
                   {"name": "MaCité fond de carte hors ligne", "attribution": attribution, "description": "Rendu local de données vectorielles ; aucune tuile tierce copiée."})
    print(f"{n} tuiles, zooms {a.minzoom}-{a.maxzoom}, attribution : {attribution}")

if __name__ == "__main__": main()
