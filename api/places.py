"""Registre CENTRAL des types de lieux : une seule table `places`, un seul endroit pour les règles.
Ajouter un type (ex. « infirmerie ») = ajouter une ligne ici, sans migration de schéma."""
from dataclasses import dataclass

@dataclass(frozen=True)
class PlaceType:
    label: str
    kinds: tuple            # géométries admises : point / path / polygon
    parents: tuple = ()     # types parents admis (vide = racine, sans parent)
    parent_required: bool = False
    levelled: bool = False  # porte un niveau d'étage (0 = RDC)
    walkable: bool = False  # alimente le graphe de navigation

PLACE_TYPES: dict[str, PlaceType] = {
    "batiment":   PlaceType("Bâtiment", ("polygon",)),
    "aile":       PlaceType("Aile", ("polygon",), ("batiment",), True),
    "etage":      PlaceType("Étage", ("polygon",), ("batiment", "aile"), True, True),
    "chambre":    PlaceType("Chambre", ("polygon", "point"), ("etage",), True, True),
    "couloir":    PlaceType("Couloir", ("path",), ("etage", "aile", "batiment"), False, True, True),
    "escalier":   PlaceType("Escalier", ("point", "path"), ("batiment", "aile", "etage"), False, True, True),
    "ascenseur":  PlaceType("Ascenseur", ("point",), ("batiment", "aile", "etage"), False, True, True),
    "porte":      PlaceType("Porte", ("point",), ("batiment", "aile", "etage", "chambre"), False, True, True),
    "entree":     PlaceType("Entrée", ("point",), ("batiment",), False, False, True),
    "terrain":    PlaceType("Terrain de sport", ("polygon",)),
    "espace":     PlaceType("Espace (cour, parking, zone verte)", ("polygon",)),
    "allee":      PlaceType("Allée / route", ("path",), (), False, False, True),
    "cloture":    PlaceType("Clôture / mur", ("path", "polygon")),
    "service":    PlaceType("Service", ("point", "polygon"), ("batiment",)),
    "point_eau":  PlaceType("Point d’eau", ("point",)),
    "qr":         PlaceType("Repère QR", ("point",), ("batiment", "etage"), False, True),
    "repere":     PlaceType("Point de repère", ("point",)),
}
DEFAULT_BY_KIND = {"point": "repere", "path": "allee", "polygon": "espace"}
MIN_POINTS = {"point": 1, "path": 2, "polygon": 3}

def validate_place(type_code, kind, n_points, parent_type, level) -> list[str]:
    t = PLACE_TYPES.get(type_code)
    if not t: return [f"Type de lieu inconnu : {type_code}"]
    e = []
    if kind not in t.kinds: e.append(f"« {t.label} » n'accepte pas la géométrie « {kind} » (admis : {', '.join(t.kinds)}).")
    if n_points < MIN_POINTS.get(kind, 1): e.append(f"{MIN_POINTS[kind]} point(s) minimum pour « {kind} ».")
    if kind == "point" and n_points > 1: e.append("Un point ne contient qu'une position.")
    if not t.parents:
        if parent_type is not None: e.append(f"« {t.label} » est un lieu racine : pas de parent.")
    elif parent_type is None:
        if t.parent_required: e.append(f"« {t.label} » doit avoir un parent ({', '.join(PLACE_TYPES[p].label for p in t.parents)}).")
    elif parent_type not in t.parents: e.append(f"Parent « {parent_type} » invalide pour « {t.label} ».")
    if level is not None and not t.levelled: e.append(f"« {t.label} » n'a pas de niveau d'étage.")
    if level is None and t.levelled: e.append(f"« {t.label} » doit porter un niveau d'étage (0 = RDC) : sans lui, la navigation le placerait au rez-de-chaussée.")
    return e

# ---- Nouveaux types : pièces de bâtiment « facultatives » (un bâtiment peut en avoir ou non) et lieux externes ----
_IN = ("batiment", "aile", "etage")
for _c, _l in [("conciergerie", "Conciergerie"), ("salle_etude", "Salle d’étude"), ("salle_tv", "Salle télé"), ("menage", "Local ménage"),
               ("salle_conference", "Salle de conférence"), ("sanitaires", "Sanitaires"), ("cuisine", "Cuisine / buanderie"),
               ("local_technique", "Local technique"), ("infirmerie", "Infirmerie")]:
    PLACE_TYPES[_c] = PlaceType(_l, ("polygon", "point"), _IN, True, True)
PLACE_TYPES["magasin"] = PlaceType("Magasin / commerce (externe)", ("polygon", "point"))
OPTIONAL_ROOMS = ("conciergerie", "salle_etude", "salle_tv", "menage", "salle_conference", "sanitaires", "cuisine", "local_technique", "infirmerie")

# ---- Géométrie métrique locale ----
import math
def _xy(p, lat0): return (p[0] * math.cos(math.radians(lat0)) * 111320.0, p[1] * 111320.0)
def _dseg(p, a, b):
    ax, ay = a; bx, by = b; px, py = p; dx, dy = bx - ax, by - ay; L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))
def _pip(p, ring):
    x, y = p; ins = False
    for i in range(len(ring)):
        (x1, y1), (x2, y2) = ring[i], ring[(i + 1) % len(ring)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: ins = not ins
    return ins
def contained(child_pts, parent_ring, tol_m) -> bool:
    """Tous les points de l'enfant sont dans le polygone parent, à tol_m mètres près (le GPS intérieur est imprécis)."""
    lat0 = sum(p[1] for p in parent_ring) / len(parent_ring); R = [_xy(p, lat0) for p in parent_ring]
    for c in child_pts:
        q = _xy(c, lat0)
        if not _pip(q, R) and min(_dseg(q, R[i], R[(i + 1) % len(R)]) for i in range(len(R))) > tol_m: return False
    return True

def connectivity_warnings(paths, entrances, tol=3.0, entrance_tol=15.0) -> list[str]:
    """Réseau extérieur : tronçons isolés et entrées non reliées. paths = listes de [lon,lat] ; entrances = [(nom, [lon,lat])]."""
    out = []
    if not paths:
        return ["Aucun chemin extérieur publié : aucun itinéraire ne sera possible."] if entrances else []
    lat0 = sum(p[1] for pa in paths for p in pa) / sum(len(pa) for pa in paths); P = [[_xy(p, lat0) for p in pa] for pa in paths]
    par = list(range(len(P)))
    def f(i):
        while par[i] != i: par[i] = par[par[i]]; i = par[i]
        return i
    for i in range(len(P)):
        for j in range(i + 1, len(P)):
            if f(i) == f(j): continue
            # Même règle que le client (web/src/lib/graph.ts, snapPaths) : seules les EXTRÉMITÉS d'un chemin sont rattachées à un autre chemin.
            # Avant, n'importe quel sommet comptait : la publication annonçait « connecté » alors que l'application ne reliait pas ces chemins.
            ends = lambda a: (a[0], a[-1])
            near = any(min((_dseg(v, P[j][k], P[j][k + 1]) for k in range(len(P[j]) - 1)), default=9e9) <= tol for v in ends(P[i])) or \
                   any(min((_dseg(v, P[i][k], P[i][k + 1]) for k in range(len(P[i]) - 1)), default=9e9) <= tol for v in ends(P[j]))
            if near: par[f(i)] = f(j)
    comps = {}
    for i in range(len(P)): comps.setdefault(f(i), []).append(i)
    main = max(comps.values(), key=lambda m: sum(len(P[i]) for i in m))
    if len(comps) > 1: out.append(f"Réseau extérieur déconnecté : {len(comps)} blocs ; {len(comps) - 1} bloc(s) isolé(s) du bloc principal ({len(main)} chemin(s)).")
    for name, pt in entrances:
        q = _xy(pt, lat0); d = min((_dseg(q, P[i][k], P[i][k + 1]) for i in main for k in range(len(P[i]) - 1)), default=9e9)
        if d > entrance_tol: out.append(f"Entrée « {name} » à {d:.0f} m du réseau principal : non reliée.")
    return out

def geometry_errors(kind: str, points) -> list[str]:
    """Validité géométrique côté application (la base PostGIS refuse aussi les géométries invalides, en défense en profondeur)."""
    if kind != "polygon" or len(points) < 3: return []
    lat0 = sum(p[1] for p in points) / len(points); R = [_xy(p, lat0) for p in points]; n = len(R)
    def o(a, b, c): return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    for i in range(n):
        for j in range(i + 1, n):
            if abs(i - j) <= 1 or (i == 0 and j == n - 1): continue
            a, b, c, d = R[i], R[(i + 1) % n], R[j], R[(j + 1) % n]
            if o(a, b, c) * o(a, b, d) < 0 and o(c, d, a) * o(c, d, b) < 0: return ["Le contour se croise lui-même."]
    area = abs(sum(R[i][0] * R[(i + 1) % n][1] - R[(i + 1) % n][0] * R[i][1] for i in range(n))) / 2
    return ["Surface quasi nulle : contour dégénéré."] if area < 1 else []
