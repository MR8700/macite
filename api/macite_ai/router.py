"""Routes IA de MaCité, branchables sur l'application existante par injection de dépendances."""
import math, os, threading, time
from typing import Callable, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from . import provider as P
from .search import rank, tokens

def _pub(p: dict) -> dict:
    return {k: p.get(k) for k in ("id", "name", "type_label", "type", "level", "number", "parent_id", "parent_name", "points")}

def _dist(p: dict, lat: float, lon: float) -> float:
    kx = math.cos(math.radians(lat)) * 111320
    return min((math.hypot((pt[0] - lon) * kx, (pt[1] - lat) * 110540) for pt in p.get("points") or []), default=math.inf)

class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    ack: bool
    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lon: Optional[float] = Field(default=None, ge=-180, le=180)

class LiveIn(BaseModel):
    ack: bool

class LiveReportIn(BaseModel):
    seconds: int = Field(ge=0, le=3600)

class SurveyTextIn(BaseModel):   # (ne pas confondre avec main.SurveyIn, le relevé complet)
    text: str = Field(min_length=1, max_length=800)
    ack: bool

def build_router(*, get_db: Callable, require_user: Callable, get_places: Callable[[Session], list[dict]],
                 place_types: dict[str, str], get_provider: Callable[[], Optional[P.Provider]], Usage,
                 audit: Optional[Callable[[Session, str, str], None]] = None, parent_types: Optional[set[str]] = None,
                 per_user: Optional[int] = None, global_limit: Optional[int] = None,
                 get_live: Optional[Callable[[], Optional[object]]] = None,
                 live_per_user: Optional[int] = None, live_global: Optional[int] = None, live_cooldown_s: Optional[float] = None,
                 live_max_session_s: Optional[int] = None, clock: Callable[[], float] = time.monotonic,
                 client_id: Optional[Callable[[Request], str]] = None) -> APIRouter:
    """get_places(db) -> lieux PUBLIÉS (dicts avec id, name, type_label, type, level, number, parent_id, parent_name, points=[[lon,lat],…]).
    require_user : dépendance FastAPI qui applique VOS rôles et renvoie un objet avec .username. audit : journal sans texte utilisateur."""
    per_user = per_user if per_user is not None else int(os.getenv("MACITE_AI_DAILY_PER_USER", "20"))
    global_limit = global_limit if global_limit is not None else int(os.getenv("MACITE_AI_DAILY_GLOBAL", "400"))
    # Quotas de la voix SÉPARÉS de ceux du texte : une session vocale coûte bien plus qu'une requête texte, et l'un ne doit pas épuiser l'autre.
    live_per_user = live_per_user if live_per_user is not None else int(os.getenv("MACITE_AI_LIVE_DAILY_PER_USER", "5"))
    live_global = live_global if live_global is not None else int(os.getenv("MACITE_AI_LIVE_DAILY_GLOBAL", "50"))
    live_cooldown_s = live_cooldown_s if live_cooldown_s is not None else float(os.getenv("MACITE_AI_LIVE_COOLDOWN_S", "10"))
    live_max_session_s = live_max_session_s if live_max_session_s is not None else int(os.getenv("MACITE_AI_LIVE_MAX_SESSION_S", "300"))
    log = audit or (lambda *_: None)
    router = APIRouter(prefix="/api/v1")
    last_mint: dict[str, float] = {}; mint_lock = threading.Lock()   # anti-rafale par utilisateur (mémoire du processus : voir docs/ASSISTANT_IA.md)

    def _today() -> str: return time.strftime("%Y-%m-%d", time.gmtime())
    def _ensure(db: Session, day: str, scope: str):
        if db.get(Usage, (day, scope)) is None:
            try: db.add(Usage(day=day, scope=scope, count=0)); db.commit()
            except IntegrityError: db.rollback()
    def _spend(db: Session, scopes):
        """scopes : (portée, limite, code HTTP, message). UPDATE conditionnel : atomique même en cas de requêtes simultanées. Tout ou rien."""
        day = _today()
        for scope, *_ in scopes: _ensure(db, day, scope)
        for scope, limit, code, msg in scopes:
            r = db.execute(update(Usage).where(Usage.day == day, Usage.scope == scope, Usage.count < limit).values(count=Usage.count + 1))
            if r.rowcount != 1: db.rollback(); raise HTTPException(code, msg)
        db.commit()
    def _refund(db: Session, scopes):
        day = _today()
        for scope, *_ in scopes: db.execute(update(Usage).where(Usage.day == day, Usage.scope == scope, Usage.count > 0).values(count=Usage.count - 1))
        db.commit()
    def _add(db: Session, scope: str, n: int):
        day = _today(); _ensure(db, day, scope); db.execute(update(Usage).where(Usage.day == day, Usage.scope == scope).values(count=Usage.count + n))
    def _get(db: Session, scope: str) -> int:
        row = db.get(Usage, (_today(), scope)); return row.count if row else 0
    def text_scopes(username: str):
        return ((f"u:{username}", per_user, 429, "Limite quotidienne de l'assistant atteinte pour votre compte."),
                ("global", global_limit, 503, "L'assistant est indisponible aujourd'hui (budget quotidien atteint)."))
    def live_scopes(username: str):
        return ((f"live:u:{username}", live_per_user, 429, "Limite quotidienne de conversations vocales atteinte pour votre compte."),
                ("live:global", live_global, 503, "La conversation vocale est indisponible aujourd'hui (budget quotidien atteint)."))
    def spend(db: Session, username: str):
        scopes = text_scopes(username); _spend(db, scopes); return scopes
    def call_model(db: Session, scopes, prov, system: str, user: str):
        """Appel au fournisseur. Si le fournisseur n'a rien répondu (panne, délai, 429 de Google), la tentative est REMBOURSÉE, comme pour la voix :
        l'utilisateur ne perd pas de quota sur un appel qui n'a pas abouti. Une réponse reçue mais inutilisable reste comptée (Google l'a facturée)."""
        try: return prov.generate_json(system, user)
        except P.ProviderError: _refund(db, scopes); return None

    search_hits: dict[str, list[float]] = {}; search_lock = threading.Lock()   # limitation de débit par client (mémoire du processus ; doublée côté Caddy en production)
    search_per_min = int(os.getenv("MACITE_SEARCH_PER_MIN", "60"))
    def _search_allowed(client: str) -> bool:
        now = clock()
        with search_lock:
            if len(search_hits) > 2000:   # purge : le dictionnaire ne doit pas grossir sans limite
                for k in [k for k, v in search_hits.items() if not v or now - v[-1] >= 60]: del search_hits[k]
            hits = [t for t in search_hits.get(client, []) if now - t < 60]
            if len(hits) >= search_per_min: search_hits[client] = hits; return False
            search_hits[client] = hits + [now]; return True

    @router.get("/search")
    def search(request: Request, q: str = Query(..., max_length=200), limit: int = Query(8, ge=1, le=20), db: Session = Depends(get_db)):
        """Recherche approximative des lieux publiés : publique, sans IA, sans coût. Limitée par client (MACITE_SEARCH_PER_MIN, 60 par défaut)."""
        if not _search_allowed(client_id(request) if client_id else (request.client.host if request.client else "?")): raise HTTPException(429, "Trop de recherches : réessayez dans une minute.")
        return [_pub(p) | {"score": p["score"]} for p in rank(q, get_places(db), limit)]

    @router.get("/ai/status")
    def status(): return {"enabled": get_provider() is not None}

    @router.get("/ai/live/status")
    def live_status(): return {"enabled": bool(get_live and get_live() is not None)}

    @router.post("/ai/live-token")
    def live_token(b: LiveIn, user=Depends(require_user), db: Session = Depends(get_db)):
        """Jeton éphémère pour parler à Gemini Live DIRECTEMENT depuis l'appareil (l'audio ne passe pas par notre serveur). Un jeton = une session."""
        if not b.ack: raise HTTPException(422, "Consentement requis : votre voix est envoyée directement à un service d'IA externe.")
        m = get_live() if get_live else None
        if m is None: raise HTTPException(503, "Assistant vocal désactivé.")
        now = clock()
        with mint_lock:   # pas de création de jetons en rafale (double clic, boucle de reconnexion) : un jeton à la fois par utilisateur
            wait = live_cooldown_s - (now - last_mint[user.username]) if user.username in last_mint else 0
            if wait > 0:
                raise HTTPException(429, f"Patientez {math.ceil(wait)} s avant de relancer la conversation vocale.", headers={"Retry-After": str(math.ceil(wait))})
            last_mint[user.username] = now
            for k in [k for k, t in last_mint.items() if now - t > 3600]: del last_mint[k]
        scopes = live_scopes(user.username)
        _spend(db, scopes)
        try: out = m.mint()
        except P.ProviderError:
            _refund(db, scopes)   # Google n'a pas fourni de jeton : la tentative ne compte pas dans le quota (la pause anti-rafale, elle, reste)
            log(db, user.username, "ai live-token failed"); db.commit()
            raise HTTPException(502, "Assistant vocal indisponible.")
        log(db, user.username, "ai live-token"); db.commit()
        return out

    @router.post("/ai/live/report")
    def live_report(b: LiveReportIn, user=Depends(require_user), db: Session = Depends(get_db)):
        """Mesure du coût pendant le pilote : durée réellement écoutée d'une session. Donnée déclarée par l'appareil (non fiable) : bornée,
        et jamais plus de rapports que de jetons délivrés aujourd'hui. Aucun contenu de conversation n'est reçu ni stocké."""
        u = user.username
        if _get(db, f"live_started:u:{u}") >= _get(db, f"live:u:{u}"): return {"recorded": False}
        secs = min(b.seconds, live_max_session_s + 60)
        for who in (f"u:{u}", "global"): _add(db, f"live_started:{who}", 1); _add(db, f"live_sec:{who}", secs)
        log(db, u, "ai live-end"); db.commit()
        return {"recorded": True}

    @router.get("/ai/live/usage")
    def live_usage(user=Depends(require_user), db: Session = Depends(get_db)):
        """Consommation du jour (UTC) de l'utilisateur : jetons délivrés, sessions ouvertes, secondes écoutées, restant."""
        u = user.username; used = _get(db, f"live:u:{u}")
        return {"day": _today(), "tokens": used, "sessions": _get(db, f"live_started:u:{u}"), "seconds": _get(db, f"live_sec:u:{u}"),
                "remaining": max(0, live_per_user - used), "limit": live_per_user, "max_session_s": live_max_session_s}

    @router.get("/ai/usage")
    def usage(user=Depends(require_user), db: Session = Depends(get_db)):
        """Quota TEXTE du jour (UTC) : l'utilisateur voit ce qu'il lui reste avant de se heurter à un 429. Aucun appel au fournisseur."""
        used = _get(db, f"u:{user.username}")
        return {"day": _today(), "used": used, "limit": per_user, "remaining": max(0, per_user - used)}

    @router.post("/ai/chat")
    def chat(b: ChatIn, user=Depends(require_user), db: Session = Depends(get_db)):
        if not b.ack: raise HTTPException(422, "Consentement requis : votre message est envoyé à un service d'IA externe.")
        prov = get_provider()
        if prov is None: raise HTTPException(503, "Assistant désactivé.")
        places = get_places(db)
        if not tokens(b.message):   # rien d'exploitable (mots vides, ponctuation) : inutile de dépenser un appel d'IA
            log(db, user.username, "ai not_found no-tokens"); db.commit()
            return {"action": "not_found", "degraded": False, "message": "Je ne trouve pas ce lieu dans les données de MaCité."}
        cands = rank(b.message, places, 15)
        scopes = spend(db, user.username)
        raw = call_model(db, scopes, prov, P.SYSTEM, P.build_user_payload(b.message, cands, place_types))
        d = P.parse_decision(raw, {c["id"] for c in cands}, set(place_types)); degraded = d is None
        d = d or P.fallback_decision(cands); by = {p["id"]: p for p in places}
        log(db, user.username, f"ai {d.action} {d.place_id or d.place_type or ''}{' degraded' if degraded else ''}"); db.commit()   # jamais le texte
        out: dict = {"action": d.action, "degraded": degraded}
        if d.action in ("show_place", "navigate"):
            p = by[d.place_id]; out["place"] = _pub(p)
            where = (f", niveau {p['level']}" if p.get("level") is not None else "") + (f", dans {p['parent_name']}" if p.get("parent_name") else "")
            out["message"] = f"{p['name']} ({p.get('type_label')}{where}). " + ("Je prépare l'itinéraire." if d.action == "navigate" else "Je l'affiche sur la carte.")
        elif d.action == "list":
            found = [p for p in places if p.get("type") == d.place_type]
            # la position reste sur NOTRE serveur : elle n'est jamais envoyée au fournisseur d'IA
            found = sorted(found, key=(lambda p: _dist(p, b.lat, b.lon)) if b.lat is not None and b.lon is not None else (lambda p: p["name"]))
            out["places"] = [_pub(p) for p in found[:8]]; label = place_types[d.place_type]
            out["message"] = f"{len(found)} lieu(x) « {label} » enregistré(s)." if found else f"Aucun lieu « {label} » n'est enregistré pour l'instant."
        elif d.action == "clarify": out["message"] = d.question; out["options"] = [_pub(c) for c in cands[:4]]
        else: out["message"] = "Je ne trouve pas ce lieu dans les données de MaCité."
        return out

    @router.post("/ai/survey-draft")
    def survey_draft(b: SurveyTextIn, user=Depends(require_user), db: Session = Depends(get_db)):
        """Transforme une description dictée en PROPOSITION de fiche. Ne crée rien : l'utilisateur vérifie puis enregistre un brouillon.
        Aucune coordonnée n'est jamais produite ici : elles viennent du GPS de l'appareil."""
        if not b.ack: raise HTTPException(422, "Consentement requis : votre texte est envoyé à un service d'IA externe.")
        prov = get_provider()
        if prov is None: raise HTTPException(503, "Assistant désactivé.")
        places = get_places(db)   # parents possibles uniquement ; un numéro inconnu (nouvelle chambre) ne doit pas les éliminer
        pool = [p for p in places if parent_types is None or p.get("type") in parent_types]
        parents = rank(b.text, pool, 15, min_score=0.2, strict_digits=False)
        scopes = spend(db, user.username)
        raw = call_model(db, scopes, prov, P.SYSTEM_SURVEY, P.build_survey_payload(b.text, parents, place_types))
        d = P.parse_survey(raw, set(place_types), {p["id"] for p in parents}); degraded = d is None
        d = d or P.SurveyDraft(notes=b.text[:300].replace("\n", " "))
        log(db, user.username, f"ai survey{' degraded' if degraded else ''}"); db.commit()
        return {"draft": d.model_dump(), "degraded": degraded,
                "message": "Proposition de fiche : vérifiez et corrigez avant d'enregistrer." if not degraded else "Assistant indisponible : seule votre description a été conservée comme remarque."}
    return router
