"""Recherche approximative SANS IA (fautes, accents, abréviations). Même algorithme que web/src/lib/fuzzy.ts.
Règle de sûreté : un mot contenant un chiffre doit correspondre EXACTEMENT (« D3 » ne renvoie jamais « D4 »)."""
import re, unicodedata

ABBR = {"bat": "batiment", "batt": "batiment", "ch": "chambre", "cham": "chambre", "wc": "sanitaires",
        "toilette": "sanitaires", "toilettes": "sanitaires", "foot": "terrain", "football": "terrain"}
STOP = set("le la les de du des un une au aux ou se je ma mon sur pour comment aller vers en dans quel quels quelle quelles trouve trouver cherche chercher rejoindre situe sont afficher affiche pres moi qui que est y et".split())

def norm(s: str) -> str:
    s = re.sub(r"\b([dlcjmnst])['’]", "", s.lower())
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()

def tokens(s: str) -> list[str]:
    return [ABBR.get(t, t) for t in norm(s).split() if t not in STOP]

def _bi(w: str) -> set:
    w = f" {w} "
    return {w[i:i + 2] for i in range(len(w) - 1)}

def dice(a: str, b: str) -> float:
    A, B = _bi(a), _bi(b)
    return 2 * len(A & B) / (len(A) + len(B)) if A and B else 0.0

def _has_digit(s: str) -> bool:
    return any(c.isdigit() for c in s)

PARENT_WEIGHT = 0.6   # un mot du lieu PARENT compte moins qu'un mot du lieu lui-même (« D3 » → le bâtiment avant ses chambres)

def tok_score(q: str, hay: list[tuple[str, float]]) -> float:
    best = 0.0
    for h, w in hay:
        if q == h: best = max(best, w); continue
        if _has_digit(q) or _has_digit(h): continue
        if len(q) >= 3 and h.startswith(q): best = max(best, 0.9 * w)
        else:
            s = dice(q, h)
            if s >= 0.6: best = max(best, 0.8 * s * w)
    return best

def score(qt: list[str], ht: list[tuple[str, float]], strict_digits: bool = True) -> float:
    if not qt: return 0.0
    parts = [tok_score(q, ht) for q in qt]
    if strict_digits and any(_has_digit(q) and p == 0 for q, p in zip(qt, parts)): return 0.0
    return sum(parts) / len(parts)

def haystack(p: dict) -> list[tuple[str, float]]:
    own = tokens(" ".join(str(x) for x in (p.get("name"), p.get("number"), p.get("type_label")) if x))
    return [(t, 1.0) for t in own] + [(t, PARENT_WEIGHT) for t in tokens(str(p.get("parent_name") or ""))]

def rank(query: str, places: list[dict], limit: int = 8, min_score: float = 0.45, strict_digits: bool = True) -> list[dict]:
    """strict_digits=False : un nombre sans correspondance baisse le score au lieu de l'annuler (choix d'un PARENT pour un lieu pas encore enregistré)."""
    qt = tokens(query); out = []
    for p in places:
        s = score(qt, haystack(p), strict_digits)
        if s >= min_score: out.append({**p, "score": round(s, 3)})
    return sorted(out, key=lambda x: (-x["score"], x["name"]))[:limit]
