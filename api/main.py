"""API MaCité (v0.1). Autorité serveur : droits, validation, publication.
Stockage : SQLAlchemy (SQLite par défaut, DATABASE_URL pour PostgreSQL + PostGIS via Alembic, voir migrations/).
Les géométries restent aussi en JSON (`points`) : c'est la source de vérité ; la colonne PostGIS `geom` est dérivée par trigger."""
import hashlib, hmac, json, math, os, re, secrets, time
from contextlib import asynccontextmanager
from typing import Literal, Optional
from pathlib import Path
from fastapi.responses import FileResponse
from places import geometry_errors, DEFAULT_BY_KIND, OPTIONAL_ROOMS, PLACE_TYPES, connectivity_warnings, contained, validate_place
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from security import load_secret
from macite_ai import build_router, make_usage_model, provider_from_env, live_from_env
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text, JSON, Boolean, Float, Integer, String, Text, create_engine, delete, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///macite.db")
# Render fournit une URL PostgreSQL générique ; l'image installe psycopg v3 (pas psycopg2).
if DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {})
MAX_ACC = float(os.getenv("MACITE_MAX_ACCURACY_M", "15")); CONTAIN_TOL = float(os.getenv("MACITE_CONTAIN_TOL_M", "8"))
SECRET = load_secret()   # MACITE_ENV=production : refuse de démarrer si MACITE_SECRET est absent ou faible (security.py)

class Base(DeclarativeBase): pass
class User(Base):
    __tablename__ = "users"
    username: Mapped[str] = mapped_column(String, primary_key=True); pw: Mapped[str] = mapped_column(String); role: Mapped[str] = mapped_column(String)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
class SurveyRow(Base):
    __tablename__ = "surveys"
    id: Mapped[str] = mapped_column(String, primary_key=True); owner: Mapped[str] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String); name: Mapped[str] = mapped_column(String)
    notes: Mapped[str] = mapped_column(Text, default=""); points: Mapped[list] = mapped_column(JSON); accuracies: Mapped[list] = mapped_column(JSON)
    orientation: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String, default="a_verifier"); version: Mapped[int] = mapped_column(Integer, default=1)
    place_type: Mapped[Optional[str]] = mapped_column(String, nullable=True); parent_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    level: Mapped[Optional[int]] = mapped_column(Integer, nullable=True); number: Mapped[Optional[str]] = mapped_column(String, nullable=True); place_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    reject_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True); published_in: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
class Place(Base):
    """Lieu officiel (une seule table polymorphe, règles dans places.py). Table de travail ; la carte publiée = snapshot de map_versions."""
    __tablename__ = "places"
    id: Mapped[str] = mapped_column(String, primary_key=True); type: Mapped[str] = mapped_column(String, index=True)
    name: Mapped[str] = mapped_column(String); number: Mapped[Optional[str]] = mapped_column(String, nullable=True); description: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[str] = mapped_column(String); points: Mapped[list] = mapped_column(JSON)
    parent_id: Mapped[Optional[str]] = mapped_column(String, index=True, nullable=True); level: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    accessible: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True); props: Mapped[dict] = mapped_column(JSON, default=dict)
    state: Mapped[str] = mapped_column(String, default="valide")  # valide (à publier) | publie | archive
    survey_id: Mapped[Optional[str]] = mapped_column(String, nullable=True); version: Mapped[int] = mapped_column(Integer, default=1)
    # Provenance de la position (traçabilité) : gps | carte (pointée) | estimee
    pos_source: Mapped[str] = mapped_column(String, default="carte"); acc_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    captured_at: Mapped[Optional[float]] = mapped_column(Float, nullable=True); orientation: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True); override_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
class Photo(Base):
    __tablename__ = "survey_photos"
    id: Mapped[str] = mapped_column(String, primary_key=True); survey_id: Mapped[str] = mapped_column(String, index=True); path: Mapped[str] = mapped_column(String)
class MapVersion(Base):
    __tablename__ = "map_versions"
    version: Mapped[int] = mapped_column(Integer, primary_key=True); created_by: Mapped[str] = mapped_column(String); at: Mapped[float] = mapped_column(Float)
    snapshot: Mapped[list] = mapped_column(JSON)  # photographie immuable → retour arrière possible
class Audit(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True); at: Mapped[float] = mapped_column(Float); who: Mapped[str] = mapped_column(String); what: Mapped[str] = mapped_column(String)
class LoginFail(Base):
    """Échecs de connexion récents (fenêtre WINDOW) : en BASE, donc partagés entre tous les workers et conservés au redémarrage. Migration 0004.
    key = « u:<adresse>|<identifiant> » (verrou par couple) ou « ip:<adresse> » (plafond par adresse)."""
    __tablename__ = "login_fails"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True); key: Mapped[str] = mapped_column(String, index=True); at: Mapped[float] = mapped_column(Float, index=True)
AiUsage = make_usage_model(Base)   # compteurs d'appels à l'IA (quotas) : migration 0003

def migrate():
    """PostgreSQL : migrations Alembic (schéma + PostGIS). SQLite (dev/tests rapides) : create_all."""
    if engine.dialect.name == "postgresql":
        from alembic import command
        from alembic.config import Config
        here = Path(__file__).parent; cfg = Config(str(here / "alembic.ini")); cfg.set_main_option("script_location", str(here / "migrations"))
        cfg.set_main_option("sqlalchemy.url", engine.url.render_as_string(hide_password=False).replace("%", "%%")); cfg.attributes["configured"] = True
        command.upgrade(cfg, "head")
    else: Base.metadata.create_all(engine)
PBKDF2_ROUNDS = 120_000
def _legacy_hpw(p: str) -> str: return hashlib.pbkdf2_hmac("sha256", p.encode(), SECRET.encode(), PBKDF2_ROUNDS).hex()   # ancien format : sel = secret commun
def hpw(p: str) -> str:
    """Nouveau format `pbkdf2$<sel>$<empreinte>` : sel aléatoire PAR compte (deux mots de passe identiques ≠ même empreinte, et changer MACITE_SECRET n'invalide plus les mots de passe)."""
    salt = secrets.token_hex(16); return f"pbkdf2${salt}${hashlib.pbkdf2_hmac('sha256', p.encode(), bytes.fromhex(salt), PBKDF2_ROUNDS).hex()}"
def check_pw(stored: str, p: str) -> bool:
    if stored.startswith("pbkdf2$"):
        try: _, salt, h = stored.split("$"); return hmac.compare_digest(h, hashlib.pbkdf2_hmac("sha256", p.encode(), bytes.fromhex(salt), PBKDF2_ROUNDS).hex())
        except ValueError: return False
    return hmac.compare_digest(stored, _legacy_hpw(p))
TOKEN_TTL = float(os.getenv("MACITE_TOKEN_TTL_H", "12")) * 3600
def _mac(msg: str) -> str: return hmac.new(SECRET.encode(), msg.encode(), "sha256").hexdigest()
def sign(u: str, exp: Optional[int] = None) -> str:
    exp = exp if exp is not None else int(time.time() + TOKEN_TTL); return f"{u}|{exp}|{_mac(f'{u}|{exp}')}"
def parse_token(tok: str) -> Optional[str]:
    """Retourne le nom d'utilisateur si le jeton est authentique ET non expiré, sinon None."""
    try: u, exp, mac = tok.split("|")
    except ValueError: return None
    return u if hmac.compare_digest(mac, _mac(f"{u}|{exp}")) and exp.isdigit() and int(exp) > time.time() else None
MAX_FAILS, WINDOW = 5, 300
MAX_FAILS_PER_IP = int(os.getenv("MACITE_LOGIN_MAX_FAILS_PER_IP", "30"))   # filet de sécurité contre un client qui essaie beaucoup d'identifiants
TRUST_PROXY = os.getenv("MACITE_TRUST_PROXY", "").strip().lower() in ("1", "true", "yes")
CLIENT_IP_HEADER = os.getenv("MACITE_CLIENT_IP_HEADER", "x-forwarded-for").strip().lower()
def client_ip(request: Request) -> str:
    """Adresse du client selon l'en-tête défini par le proxy de confiance."""
    if TRUST_PROXY and (forwarded := request.headers.get(CLIENT_IP_HEADER)):
        # Render/Cloudflare fournit CF-Connecting-IP, écrasé à l'edge ; Caddy append son IP au XFF.
        return (forwarded.split(",")[-1] if CLIENT_IP_HEADER == "x-forwarded-for" else forwarded).strip() or "?"
    return request.client.host if request.client else "?"
def get_db():
    with Session(engine) as s: yield s
def log(db: Session, who: str, what: str): db.add(Audit(at=time.time(), who=who, what=what))

def me(authorization: str = Header(default=""), db: Session = Depends(get_db)) -> User:
    u = parse_token(authorization.removeprefix("Bearer ").strip())
    if not u or not (user := db.get(User, u)) or not user.active: raise HTTPException(401, "Non authentifié")
    return user
def need(*roles: str):
    def dep(user: User = Depends(me)) -> User:
        if user.role not in roles: raise HTTPException(403, "Permissions insuffisantes")
        return user
    return dep

Kind = Literal["point", "path", "polygon"]
class SurveyIn(BaseModel):   # `id` sert de nom de dossier pour les photos : jeu de caractères restreint (jamais « .. » ni « / »)
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"); kind: Kind; name: str = Field(min_length=1, max_length=200)
    notes: str = Field(default="", max_length=4000); points: list[list[float]] = Field(max_length=5000); accuracies: list[Optional[float]] = []
    orientation: Optional[dict] = None; version: int = 1
    place_type: Optional[str] = None; parent_id: Optional[str] = None; level: Optional[int] = None; number: Optional[str] = Field(default=None, max_length=40)
    @field_validator("points")
    @classmethod
    def coords(cls, v):
        for p in v:
            if len(p) != 2 or abs(p[0]) > 180 or abs(p[1]) > 90: raise ValueError("coordonnées invalides")
        return v
    def check(self):
        mn = {"point": 1, "path": 2, "polygon": 3}[self.kind]
        if len(self.points) < mn: raise ValueError(f"{mn} point(s) minimum")
        if self.kind == "point" and len(self.points) != 1: raise ValueError("un seul point attendu")
class SyncIn(BaseModel): surveys: list[SurveyIn] = Field(max_length=200)
class Reason(BaseModel): reason: Optional[str] = None
class Login(BaseModel): username: str = Field(max_length=200); password: str = Field(max_length=500)

@asynccontextmanager
async def lifespan(_app):
    init(); yield
app = FastAPI(title="MaCité API", version="0.1.0", lifespan=lifespan)
ai_live = None   # jeton éphémère Gemini Live ; None = assistant vocal désactivé
ai_provider = None   # fournisseur d'IA (Google AI Studio) ; None = assistant désactivé
cors_origins = [origin.strip() for origin in os.getenv("MACITE_CORS_ORIGINS", "").split(",") if origin.strip()]
if cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=cors_origins, allow_methods=["*"], allow_headers=["Authorization", "Content-Type"])
ROLES = ("releveur", "expert", "admin")
Role = Literal["releveur", "expert", "admin"]
ANY_USER = need(*ROLES)   # tout compte actif
SYNC_ENV_PW = os.getenv("MACITE_SYNC_ENV_PASSWORDS", "").strip().lower() in ("1", "true", "yes")
def init():
    global ai_provider, ai_live
    ai_provider = provider_from_env(); ai_live = live_from_env()   # MACITE_AI_PROVIDER=off par défaut
    migrate()
    with Session(engine) as db:  # comptes initiaux : à créer via variables d'environnement, jamais codés en dur
        for role in ROLES:
            pw = os.getenv(f"MACITE_{role.upper()}_PASSWORD")
            u = db.get(User, role)
            if pw and not u: db.add(User(username=role, pw=hpw(pw), role=role, active=True))
            elif pw and u and SYNC_ENV_PW and not check_pw(u.pw, pw): u.pw = hpw(pw); u.active = True   # opt-in (MACITE_SYNC_ENV_PASSWORDS=1) : la variable devient la référence
        db.commit()

def _fail_count(db: Session, key: str, now: float) -> int:
    return db.scalar(select(func.count()).select_from(LoginFail).where(LoginFail.key == key, LoginFail.at > now - WINDOW)) or 0
def clear_user_fails(db: Session, username: str):
    db.execute(delete(LoginFail).where(LoginFail.key.startswith("u:"), LoginFail.key.endswith("|" + username[:100], autoescape=True)))

@app.post("/api/v1/auth/login")
def login(b: Login, request: Request, db: Session = Depends(get_db)):
    """Verrou par couple (adresse, identifiant) : un tiers ne peut plus bloquer le compte d'un autre depuis sa propre adresse. Plafond d'échecs par adresse en plus.
    Compteurs EN BASE (table login_fails) : valables avec plusieurs workers et après redémarrage."""
    now = time.time(); ip = client_ip(request); k_user, k_ip = f"u:{ip}|{b.username[:100]}", f"ip:{ip}"
    if _fail_count(db, k_user, now) >= MAX_FAILS or _fail_count(db, k_ip, now) >= MAX_FAILS_PER_IP: raise HTTPException(429, "Trop d'échecs : réessayez dans quelques minutes.")
    u = db.get(User, b.username)
    if not u or not u.active or not check_pw(u.pw, b.password):
        db.execute(delete(LoginFail).where(LoginFail.at <= now - WINDOW))   # purge des échecs expirés : la table reste petite
        db.add_all([LoginFail(key=k_user, at=now), LoginFail(key=k_ip, at=now)]); db.commit(); raise HTTPException(401, "Identifiants invalides")
    db.execute(delete(LoginFail).where(LoginFail.key == k_user))
    if not u.pw.startswith("pbkdf2$"): u.pw = hpw(b.password)   # migration transparente des comptes existants vers le sel par utilisateur
    db.commit()
    return {"token": sign(u.username), "role": u.role}

class PwChange(BaseModel): current: str; new: str = Field(min_length=10, max_length=200)
class PwReset(BaseModel): new: str = Field(min_length=10, max_length=200)
@app.post("/api/v1/auth/password")
def change_password(b: PwChange, user: User = Depends(ANY_USER), db: Session = Depends(get_db)):
    if not check_pw(user.pw, b.current): raise HTTPException(403, "Mot de passe actuel incorrect")
    user.pw = hpw(b.new); log(db, user.username, "password change"); db.commit(); return {"ok": True}

@app.post("/api/v1/sync")
def sync(b: SyncIn, user: User = Depends(ANY_USER), db: Session = Depends(get_db)):
    out = []
    for s in b.surveys:
        try: s.check()
        except ValueError as e: out.append({"id": s.id, "ok": False, "error": str(e)}); continue
        ptype = s.place_type if s.place_type in PLACE_TYPES else DEFAULT_BY_KIND[s.kind]
        par = db.get(Place, s.parent_id) if s.parent_id else None
        ptyp = par.type if par and par.state != "archive" else None
        if s.parent_id and not ptyp: out.append({"id": s.id, "ok": False, "error": "Parent introuvable ou archivé"}); continue
        pe = validate_place(ptype, s.kind, len(s.points), ptyp, s.level) + geometry_errors(s.kind, s.points)
        if pe: out.append({"id": s.id, "ok": False, "error": " ".join(pe)}); continue
        row = db.get(SurveyRow, s.id)
        if row and (row.owner != user.username and user.role == "releveur"): out.append({"id": s.id, "ok": False, "error": "Relevé d'un autre utilisateur"}); continue
        if row and row.version > s.version: out.append({"id": s.id, "ok": False, "conflict": True}); continue  # pas d'écrasement silencieux
        if row and row.status in ("valide", "publie"): out.append({"id": s.id, "ok": False, "error": "Relevé déjà validé : non modifiable"}); continue
        d = dict(kind=s.kind, name=s.name, notes=s.notes, points=s.points, accuracies=s.accuracies, orientation=s.orientation, place_type=ptype, parent_id=s.parent_id, level=s.level, number=s.number)
        if row:
            for k, v in d.items(): setattr(row, k, v)
            row.version = s.version + 1; row.status = "a_verifier"; row.reject_reason = None   # une correction soumise efface l'ancien motif de rejet
        else: db.add(SurveyRow(id=s.id, owner=user.username, version=s.version + 1, status="a_verifier", **d))
        log(db, user.username, f"submit {s.id}"); out.append({"id": s.id, "ok": True, "version": s.version + 1})   # le client reprend cette version : sans cela, toute resoumission après rejet serait vue comme un conflit
    db.commit(); return {"results": out}

def dump(r: SurveyRow): return {c: getattr(r, c) for c in ("id", "kind", "name", "place_type", "notes", "points", "accuracies", "orientation", "status", "version", "reject_reason")}
@app.get("/api/v1/surveys")
def surveys(status: Optional[str] = None, limit: int = Query(100, ge=1, le=200), offset: int = Query(0, ge=0), user: User = Depends(ANY_USER), db: Session = Depends(get_db)):
    q = select(SurveyRow).order_by(SurveyRow.id).limit(limit).offset(offset)   # sans ORDER BY, la pagination n'est pas déterministe
    if status: q = q.where(SurveyRow.status == status)
    if user.role == "releveur": q = q.where(SurveyRow.owner == user.username)
    return [dump(r) for r in db.scalars(q)]

def transition(db, user, sid, status, reason=None):
    r = db.get(SurveyRow, sid)
    if not r: raise HTTPException(404, "Relevé introuvable")
    if r.status != "a_verifier": raise HTTPException(409, f"Statut actuel « {r.status} »")
    r.status = status; r.reject_reason = reason; log(db, user.username, f"{status} {sid} {reason or ''}"); db.commit(); return {"id": sid, "status": status}
class Approve(BaseModel): force: bool = False; reason: Optional[str] = None
@app.post("/api/v1/surveys/{sid}/approve")
def approve(sid: str, b: Optional[Approve] = None, user: User = Depends(need("expert", "admin")), db: Session = Depends(get_db)):
    r = db.get(SurveyRow, sid); b = b or Approve()
    if r and r.status == "a_verifier":
        par = db.get(Place, r.parent_id) if r.parent_id else None
        if r.parent_id and (not par or par.state == "archive"): raise HTTPException(409, "Le parent de ce relevé n'existe plus")
        pe = validate_place(r.place_type, r.kind, len(r.points), par.type if par else None, r.level) + geometry_errors(r.kind, r.points)
        if pe: raise HTTPException(422, " ".join(pe))
        accs = [a for a in (r.accuracies or []) if a is not None]; acc = max(accs) if accs else None
        # point(s) posé(s) à la main : précision inconnue -> provenance « carte », jamais présentée comme GPS
        src = "gps" if accs and len(accs) == len(r.points) else "carte"   # mixte (GPS partiel) = « carte » : le contrat reste gps | carte | estimee
        ov = quality_check(db, r.place_type, r.kind, r.points, r.parent_id, acc, r.number, r.name, force=b.force, reason=b.reason)
        db.add(Place(id=r.id, type=r.place_type, name=r.name, number=r.number, description=r.notes, kind=r.kind, points=r.points, parent_id=r.parent_id, level=r.level, survey_id=r.id,
                     state="valide", pos_source=src, acc_m=acc, orientation=r.orientation, captured_at=time.time(), override_reason=ov)); r.place_id = r.id
        if ov: log(db, user.username, f"derogation {sid}: {ov}")
    return transition(db, user, sid, "valide")
@app.post("/api/v1/surveys/{sid}/reject")
def reject(sid: str, b: Reason, user: User = Depends(need("expert", "admin")), db: Session = Depends(get_db)):
    if not b.reason: raise HTTPException(422, "Motif obligatoire")
    return transition(db, user, sid, "a_corriger", b.reason)

def type_label(code: str) -> str:
    """Libellé affichable d'un code de type (« batiment » -> « Bâtiment »). Toujours DÉRIVÉ du code : rien à migrer dans les anciens instantanés de carte."""
    return PLACE_TYPES[code].label if code in PLACE_TYPES else code
def pdump(p: Place):
    return {"id": p.id, "type": p.type, "type_label": type_label(p.type), "name": p.name, "number": p.number, "description": p.description,
            "kind": p.kind, "points": p.points, "parent_id": p.parent_id, "level": p.level, "accessible": p.accessible, "version": p.version,
            "pos_source": p.pos_source, "acc_m": p.acc_m}
@app.post("/api/v1/map-versions/publish")
def publish(user: User = Depends(need("admin", "expert")), db: Session = Depends(get_db)):
    live = list(db.scalars(select(Place).where(Place.state != "archive")))
    last = db.scalars(select(MapVersion).order_by(MapVersion.version.desc())).first()
    if last and {(x["id"], x.get("version")) for x in last.snapshot} == {(p.id, p.version) for p in live}: raise HTTPException(409, "Rien de nouveau à publier")
    if not live: raise HTTPException(409, "Aucun lieu validé à publier")
    v = (last.version if last else 0) + 1
    db.add(MapVersion(version=v, created_by=user.username, at=time.time(), snapshot=[pdump(p) for p in live]))
    for p in live:
        p.state = "publie"
        if p.survey_id and (sv := db.get(SurveyRow, p.survey_id)): sv.status = "publie"; sv.published_in = v
    warn = connectivity_warnings([p.points for p in live if p.type == "allee" and p.kind == "path"], [(p.name, p.points[0]) for p in live if p.type == "entree"])
    log(db, user.username, f"publish v{v} warnings={len(warn)}"); db.commit(); return {"version": v, "places": len(live), "warnings": warn}

SITE = os.getenv("MACITE_SITE", "kossodo")   # un seul site pour l'instant
@app.get("/api/v1/sites/{site}/map")
def site_map(site: str, version: Optional[int] = None, db: Session = Depends(get_db)):
    if site != SITE: raise HTTPException(404, "Site inconnu")
    q = select(MapVersion).order_by(MapVersion.version.desc()); 
    if version: q = select(MapVersion).where(MapVersion.version == version)
    mv = db.scalars(q).first()
    if not mv: return {"version": 0, "places": []}
    # `category` : ancien nom de `type_label`, renvoyé encore un temps pour les applications installées avant le renommage (à retirer ensuite).
    return {"version": mv.version, "places": [{k: p.get(k) for k in ("id", "kind", "name", "type", "number", "parent_id", "level", "accessible", "points")}
                                              | {"type_label": type_label(p.get("type")), "category": type_label(p.get("type"))} for p in mv.snapshot]}

PHOTO_DIR = Path(os.getenv("PHOTO_DIR", "photos")); MAX_PHOTO = 2 * 1024 * 1024; MAX_PER_SURVEY = 6
@app.post("/api/v1/surveys/{sid}/photos/{pid}")
async def upload_photo(sid: str, pid: str, file: UploadFile = File(...), user: User = Depends(ANY_USER), db: Session = Depends(get_db)):
    r = db.get(SurveyRow, sid)
    if not r or (user.role == "releveur" and r.owner != user.username): raise HTTPException(404, "Relevé introuvable")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", sid): raise HTTPException(422, "Identifiant de relevé invalide")   # anciens relevés créés avant la restriction du jeu de caractères
    if r.status in ("valide", "publie"): raise HTTPException(409, "Relevé déjà validé : photos non modifiables")
    if not (0 < len(pid) <= 64 and all(c.isalnum() or c == "-" for c in pid)): raise HTTPException(422, "Identifiant invalide")
    data = await file.read(MAX_PHOTO + 1)
    if len(data) > MAX_PHOTO: raise HTTPException(413, "Photo trop lourde (max 2 Mo)")
    if not data.startswith(b"\xff\xd8\xff"): raise HTTPException(415, "JPEG uniquement")  # on vérifie le contenu, pas le nom
    known = db.get(Photo, pid)
    if known and known.survey_id != sid: raise HTTPException(409, "Identifiant de photo déjà utilisé")   # ne jamais confirmer/écraser la photo d'un autre relevé
    if known: return {"id": pid, "duplicate": True}
    if len(list(db.scalars(select(Photo).where(Photo.survey_id == sid)))) >= MAX_PER_SURVEY: raise HTTPException(409, "Trop de photos")
    d = PHOTO_DIR / sid; d.mkdir(parents=True, exist_ok=True); f = d / f"{pid}.jpg"; f.write_bytes(data)
    db.add(Photo(id=pid, survey_id=sid, path=str(f))); log(db, user.username, f"photo {pid} {sid}"); db.commit(); return {"id": pid}

def _can_see(db: Session, user: User, sid: str):
    r = db.get(SurveyRow, sid)
    if not r or (user.role == "releveur" and r.owner != user.username): raise HTTPException(404, "Relevé introuvable")
@app.get("/api/v1/surveys/{sid}/photos")
def list_photos(sid: str, user: User = Depends(ANY_USER), db: Session = Depends(get_db)):
    _can_see(db, user, sid); return [p.id for p in db.scalars(select(Photo).where(Photo.survey_id == sid))]
@app.get("/api/v1/surveys/{sid}/photos/{pid}")
def get_photo(sid: str, pid: str, user: User = Depends(ANY_USER), db: Session = Depends(get_db)):
    _can_see(db, user, sid); p = db.get(Photo, pid)
    if not p or p.survey_id != sid: raise HTTPException(404, "Photo introuvable")
    return FileResponse(p.path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})

OFFLINE_MAP = Path(os.getenv("OFFLINE_MAP_PATH", "tiles/kossodo.pmtiles"))
@app.get("/api/v1/sites/{site}/offline-map")
def offline_map(site: str):
    """Fond de carte raster PMTiles fourni par l'exploitant (généré hors ligne depuis une source dont les conditions l'autorisent)."""
    if site != SITE or not OFFLINE_MAP.is_file(): raise HTTPException(404, "Aucun fond de carte hors ligne publié")
    return FileResponse(OFFLINE_MAP, media_type="application/octet-stream", headers={"ETag": f'"{int(OFFLINE_MAP.stat().st_mtime)}-{OFFLINE_MAP.stat().st_size}"'})

# ---------- Administration (rôle admin uniquement) ----------
class NewUser(BaseModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[a-zA-Z0-9_.-]+$"); password: str = Field(min_length=10, max_length=200); role: Role
class UserPatch(BaseModel): role: Optional[Role] = None; active: Optional[bool] = None
def _admins(db: Session) -> int: return len(list(db.scalars(select(User).where(User.role == "admin", User.active == True))))  # noqa: E712

@app.get("/api/v1/admin/users")
def a_users(user: User = Depends(need("admin")), db: Session = Depends(get_db)):
    return [{"username": u.username, "role": u.role, "active": u.active} for u in db.scalars(select(User).order_by(User.username))]
@app.post("/api/v1/admin/users", status_code=201)
def a_create(b: NewUser, user: User = Depends(need("admin")), db: Session = Depends(get_db)):
    if db.get(User, b.username): raise HTTPException(409, "Identifiant déjà utilisé")
    db.add(User(username=b.username, pw=hpw(b.password), role=b.role, active=True)); log(db, user.username, f"user create {b.username} {b.role}"); db.commit()
    return {"username": b.username, "role": b.role}
@app.patch("/api/v1/admin/users/{name}")
def a_patch(name: str, b: UserPatch, user: User = Depends(need("admin")), db: Session = Depends(get_db)):
    t = db.get(User, name)
    if not t: raise HTTPException(404, "Compte introuvable")
    new_role, new_active = b.role or t.role, t.active if b.active is None else b.active
    if t.role == "admin" and t.active and (new_role != "admin" or not new_active) and _admins(db) <= 1: raise HTTPException(409, "Impossible : dernier administrateur actif")
    t.role, t.active = new_role, new_active; log(db, user.username, f"user patch {name} role={new_role} active={new_active}"); db.commit()
    return {"username": name, "role": t.role, "active": t.active}

@app.post("/api/v1/admin/users/{name}/password")
def a_reset_pw(name: str, b: PwReset, user: User = Depends(need("admin")), db: Session = Depends(get_db)):
    t = db.get(User, name)
    if not t: raise HTTPException(404, "Compte introuvable")
    t.pw = hpw(b.new); clear_user_fails(db, name); log(db, user.username, f"password reset {name}"); db.commit(); return {"username": name}

@app.get("/api/v1/admin/map-versions")
def a_versions(user: User = Depends(need("admin")), db: Session = Depends(get_db)):
    return [{"version": v.version, "by": v.created_by, "at": v.at, "places": len(v.snapshot)} for v in db.scalars(select(MapVersion).order_by(MapVersion.version.desc()))]
@app.post("/api/v1/admin/map-versions/{v}/rollback")
def a_rollback(v: int, user: User = Depends(need("admin")), db: Session = Depends(get_db)):
    """Retour arrière traçable : une NOUVELLE version recopie l'ancienne ; l'historique n'est jamais supprimé."""
    old = db.get(MapVersion, v)
    if not old: raise HTTPException(404, "Version introuvable")
    last = db.scalars(select(MapVersion).order_by(MapVersion.version.desc())).first()
    n = last.version + 1; db.add(MapVersion(version=n, created_by=user.username, at=time.time(), snapshot=old.snapshot))
    restore_working_places(db, old.snapshot)
    log(db, user.username, f"rollback to v{v} as v{n}"); db.commit(); return {"version": n, "restored_from": v}
def restore_working_places(db: Session, snapshot: list):
    """Remet la table de travail `places` dans l'état de l'instantané restauré. Sans cela, le retour arrière ne changeait que l'historique :
    la prochaine publication republiait aussitôt les lieux d'avant (et « Rien de nouveau à publier » ne se déclenchait plus)."""
    wanted = {x["id"]: x for x in snapshot}
    for p in db.scalars(select(Place)):
        if p.id not in wanted and p.state != "archive": p.state = "archive"; p.version += 1
    for pid, x in wanted.items():
        p = db.get(Place, pid); fields = dict(type=x["type"], name=x["name"], number=x.get("number"), description=x.get("description") or "", kind=x["kind"], points=x["points"],
                                              parent_id=x.get("parent_id"), level=x.get("level"), accessible=x.get("accessible"), pos_source=x.get("pos_source") or "carte", acc_m=x.get("acc_m"))
        if p is None: db.add(Place(id=pid, state="publie", version=x.get("version") or 1, **fields))
        else:
            for k, val in fields.items(): setattr(p, k, val)
            p.state = "publie"; p.version = x.get("version") or p.version   # même (id, version) que l'instantané : la publication suivante voit qu'il n'y a rien de nouveau
@app.get("/api/v1/admin/audit")
def a_audit(limit: int = 50, user: User = Depends(need("admin")), db: Session = Depends(get_db)):
    return [{"at": a.at, "who": a.who, "what": a.what} for a in db.scalars(select(Audit).order_by(Audit.id.desc()).limit(min(limit, 200)))]

# ---------- CRUD centralisé des lieux (tous types) ----------
@app.get("/api/v1/place-types")
def place_types():
    return [{"code": c, "label": t.label, "kinds": t.kinds, "parents": t.parents, "parent_required": t.parent_required, "levelled": t.levelled, "walkable": t.walkable} for c, t in PLACE_TYPES.items()]
class PlaceIn(BaseModel):
    id: Optional[str] = Field(default=None, max_length=64); type: str; name: str = Field(min_length=1, max_length=200); number: Optional[str] = Field(default=None, max_length=40)
    description: str = Field(default="", max_length=4000); kind: Kind; points: list[list[float]] = Field(max_length=5000)
    parent_id: Optional[str] = None; level: Optional[int] = Field(default=None, ge=-5, le=30); accessible: Optional[bool] = None
    pos_source: Literal["gps", "carte", "estimee"]; acc_m: Optional[float] = Field(default=None, ge=0); force: bool = False; reason: Optional[str] = None
    @field_validator("points")
    @classmethod
    def coords(cls, v): return SurveyIn.coords.__func__(cls, v)
class PlacePatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200); number: Optional[str] = Field(default=None, max_length=40); description: Optional[str] = Field(default=None, max_length=4000)
    kind: Optional[Kind] = None; points: Optional[list[list[float]]] = Field(default=None, max_length=5000); parent_id: Optional[str] = None; level: Optional[int] = Field(default=None, ge=-5, le=30); accessible: Optional[bool] = None
    pos_source: Optional[Literal["gps", "carte", "estimee"]] = None; acc_m: Optional[float] = Field(default=None, ge=0); force: bool = False; reason: Optional[str] = None
    @field_validator("points")
    @classmethod
    def coords(cls, v): return v if v is None else SurveyIn.coords.__func__(cls, v)   # avant : aucune vérification des coordonnées sur PATCH
def quality_check(db: Session, typ: str, kind: str, points, parent_id, acc_m, number, name, self_id=None, force=False, reason=None, geometry=True):
    """Règles de qualité communes (relevés validés ET lieux créés par un admin). force = dérogation tracée (motif obligatoire)."""
    problems = []
    if acc_m is not None and acc_m > MAX_ACC: problems.append(f"Précision de position insuffisante ({acc_m:.0f} m > {MAX_ACC:.0f} m).")
    par = db.get(Place, parent_id) if parent_id else None
    if geometry and par and par.kind == "polygon" and len(par.points) >= 3 and not contained(points, par.points, CONTAIN_TOL): problems.append(f"Le lieu sort de son parent « {par.name} » (tolérance {CONTAIN_TOL:.0f} m).")
    key = (number or name).strip().lower()
    for o in db.scalars(select(Place).where(Place.type == typ, Place.parent_id == parent_id, Place.state != "archive")):
        if o.id != self_id and (o.number or o.name).strip().lower() == key: raise HTTPException(409, f"Doublon : « {o.name} » existe déjà (même type et même parent).")
    if problems and not (force and reason and reason.strip()): raise HTTPException(422, " ".join(problems) + " Dérogation possible par un expert avec motif.")
    return reason if problems and force else None

def _children(db: Session, pid: str): return list(db.scalars(select(Place).where(Place.parent_id == pid, Place.state != "archive")))
def _ancestors_include(db: Session, start: Optional[str], target: str) -> bool:
    seen = set()
    while start and start not in seen:
        if start == target: return True
        seen.add(start); p = db.get(Place, start); start = p.parent_id if p else None
    return False
def _check(db, typ, kind, points, parent_id, level, self_id=None):
    par = db.get(Place, parent_id) if parent_id else None
    if parent_id and (not par or par.state == "archive"): raise HTTPException(422, "Parent introuvable ou archivé")
    if self_id and parent_id and _ancestors_include(db, parent_id, self_id): raise HTTPException(422, "Hiérarchie circulaire")
    e = validate_place(typ, kind, len(points), par.type if par else None, level) + geometry_errors(kind, points)
    if e: raise HTTPException(422, " ".join(e))

@app.get("/api/v1/places")
def places_list(type: Optional[str] = None, parent_id: Optional[str] = None, q: Optional[str] = None, state: Optional[str] = None, limit: int = Query(100, ge=1, le=200), offset: int = Query(0, ge=0),
                user: User = Depends(need("expert", "admin")), db: Session = Depends(get_db)):
    st = select(Place).order_by(Place.name, Place.id).limit(limit).offset(offset)
    st = st.where(Place.state == state) if state else st.where(Place.state != "archive")
    if type: st = st.where(Place.type == type)
    if parent_id: st = st.where(Place.parent_id == parent_id)
    if q: st = st.where(Place.name.ilike(f"%{q}%"))
    return [pdump(p) | {"state": p.state} for p in db.scalars(st)]
@app.get("/api/v1/places/{pid}")
def place_get(pid: str, user: User = Depends(need("expert", "admin")), db: Session = Depends(get_db)):
    p = db.get(Place, pid)
    if not p: raise HTTPException(404, "Lieu introuvable")
    return pdump(p) | {"state": p.state, "children": [c.id for c in _children(db, pid)]}
@app.post("/api/v1/places", status_code=201)
def place_create(b: PlaceIn, user: User = Depends(need("expert", "admin")), db: Session = Depends(get_db)):
    pid = b.id or secrets.token_hex(8)
    if db.get(Place, pid): raise HTTPException(409, "Identifiant déjà utilisé")
    _check(db, b.type, b.kind, b.points, b.parent_id, b.level)
    if b.pos_source == "gps" and b.acc_m is None: raise HTTPException(422, "Position GPS : la précision est obligatoire")
    ov = quality_check(db, b.type, b.kind, b.points, b.parent_id, b.acc_m, b.number, b.name, force=b.force, reason=b.reason)
    db.add(Place(id=pid, pos_source=b.pos_source, acc_m=b.acc_m, captured_at=time.time(), override_reason=ov, type=b.type, name=b.name, number=b.number, description=b.description, kind=b.kind, points=b.points, parent_id=b.parent_id, level=b.level, accessible=b.accessible, state="valide"))
    log(db, user.username, f"place create {pid} {b.type}"); db.commit(); return {"id": pid}
@app.patch("/api/v1/places/{pid}")
def place_patch(pid: str, b: PlacePatch, user: User = Depends(need("expert", "admin")), db: Session = Depends(get_db)):
    p = db.get(Place, pid)
    if not p or p.state == "archive": raise HTTPException(404, "Lieu introuvable")
    new = b.model_dump(exclude_unset=True)
    for k in ("pos_source", "acc_m", "force", "reason"): new.pop(k, None)
    kind, pts = new.get("kind", p.kind), new.get("points", p.points)
    parent = new["parent_id"] if "parent_id" in new else p.parent_id; level = new["level"] if "level" in new else p.level
    _check(db, p.type, kind, pts, parent, level, self_id=pid)
    if any(k in new for k in ("points", "parent_id", "name", "number")):   # un renommage ne doit pas créer de doublon (même type, même parent)
        quality_check(db, p.type, kind, pts, parent, b.acc_m, new.get("number", p.number), new.get("name", p.name), self_id=pid, force=b.force, reason=b.reason, geometry=("points" in new or "parent_id" in new))
        if "points" in new: p.pos_source = b.pos_source or "carte"; p.acc_m = b.acc_m; p.captured_at = time.time()   # le type ne change pas : on archive et recrée
    for k, v in new.items(): setattr(p, k, v)
    p.version += 1; p.state = "valide"; log(db, user.username, f"place patch {pid} {sorted(new)}"); db.commit(); return pdump(p)
@app.delete("/api/v1/places/{pid}")
def place_archive(pid: str, user: User = Depends(need("admin")), db: Session = Depends(get_db)):
    """Suppression logique : jamais de perte d'historique. Refusée s'il reste des enfants actifs."""
    p = db.get(Place, pid)
    if not p or p.state == "archive": raise HTTPException(404, "Lieu introuvable")
    kids = _children(db, pid)
    if kids: raise HTTPException(409, f"{len(kids)} lieu(x) enfant(s) actif(s) : archivez-les d'abord")
    p.state = "archive"; p.version += 1; log(db, user.username, f"place archive {pid}"); db.commit(); return {"id": pid, "state": "archive"}

# ---------- Complétude d'un bâtiment ----------
class Absent(BaseModel): type: str; absent: bool = True
@app.post("/api/v1/places/{pid}/declare-absent")
def declare_absent(pid: str, b: Absent, user: User = Depends(need("expert", "admin")), db: Session = Depends(get_db)):
    p = db.get(Place, pid)
    if not p or p.type != "batiment" or p.state == "archive": raise HTTPException(404, "Bâtiment introuvable")
    if b.type not in OPTIONAL_ROOMS: raise HTTPException(422, "Type de pièce facultative inconnu")
    absent = set(p.props.get("absent", []))
    if b.absent and any(c.type == b.type for c in _descendants(db, pid)): raise HTTPException(409, "Ce type existe déjà dans ce bâtiment")
    (absent.add if b.absent else absent.discard)(b.type); p.props = {**p.props, "absent": sorted(absent)}; p.version += 1; p.state = "valide"
    log(db, user.username, f"absent {pid} {b.type}={b.absent}"); db.commit(); return {"absent": sorted(absent)}
def _descendants(db: Session, pid: str):
    out, todo = [], [pid]
    while todo:
        for c in _children(db, todo.pop()): out.append(c); todo.append(c.id)
    return out
@app.get("/api/v1/places/{pid}/completeness")
def completeness(pid: str, user: User = Depends(need("expert", "admin")), db: Session = Depends(get_db)):
    b = db.get(Place, pid)
    if not b or b.type != "batiment" or b.state == "archive": raise HTTPException(404, "Bâtiment introuvable")
    d = _descendants(db, pid); by = lambda t: [x for x in d if x.type == t]
    floors = sorted({x.level for x in by("etage") if x.level is not None}); issues = []
    if not by("entree"): issues.append("Aucune entrée enregistrée.")
    if not floors: issues.append("Aucun étage enregistré.")
    else:
        miss = [l for l in range(floors[0], floors[-1] + 1) if l not in floors]
        if miss: issues.append(f"Niveaux manquants : {', '.join(map(str, miss))}.")
        if len(floors) > 1 and not (by("escalier") or by("ascenseur")): issues.append("Plusieurs niveaux mais aucun escalier ni ascenseur : les étages ne sont pas reliés.")
    for f in by("etage"):
        kids = [x for x in d if x.parent_id == f.id]
        if not any(k.type == "couloir" for k in kids): issues.append(f"Étage {f.level} : aucun couloir.")
        if not any(k.type == "chambre" for k in kids) and not any(k.type in OPTIONAL_ROOMS for k in kids): issues.append(f"Étage {f.level} : aucune pièce.")
    absent = set(b.props.get("absent", []))
    rooms = {t: ("present" if by(t) else "absent_declare" if t in absent else "inconnu") for t in OPTIONAL_ROOMS}
    unknown = [t for t, v in rooms.items() if v == "inconnu"]
    if unknown: issues.append(f"{len(unknown)} type(s) de pièce non renseignés (présents ou « n'existe pas ») : {', '.join(unknown)}.")
    return {"building": b.name, "levels": floors, "counts": {t: len(by(t)) for t in ("etage", "chambre", "couloir", "escalier", "ascenseur", "porte", "entree")}, "optional_rooms": rooms, "issues": issues, "complete": not issues}

# ---------- Requête spatiale ----------
@app.get("/api/v1/places/near/search")
def places_near(lon: float, lat: float, radius_m: float = 100, limit: int = 20, user: User = Depends(need("expert", "admin")), db: Session = Depends(get_db)):
    """Lieux actifs à moins de radius_m mètres. PostGIS (index GiST) si disponible, sinon calcul Python (SQLite de dev)."""
    if not (-180 <= lon <= 180 and -90 <= lat <= 90) or not (0 < radius_m <= 5000): raise HTTPException(422, "Paramètres invalides")
    limit = min(limit, 100)
    if db.get_bind().dialect.name == "postgresql":
        rows = db.execute(text("SELECT id, ST_Distance(geom::geography, q.g) AS d FROM places, (SELECT ST_SetSRID(ST_MakePoint(:lon,:lat),4326)::geography AS g) q "
                               "WHERE state <> 'archive' AND ST_DWithin(geom::geography, q.g, :r) ORDER BY d LIMIT :n"), {"lon": lon, "lat": lat, "r": radius_m, "n": limit}).all()
        return [pdump(db.get(Place, i)) | {"distance_m": round(d, 1)} for i, d in rows]
    from places import _xy
    qx = _xy([lon, lat], lat); out = []
    for p in db.scalars(select(Place).where(Place.state != "archive")):
        d = min(math.hypot(qx[0] - _xy(pt, lat)[0], qx[1] - _xy(pt, lat)[1]) for pt in p.points) if p.points else 9e9
        if d <= radius_m: out.append((d, p))
    return [pdump(p) | {"distance_m": round(d, 1)} for d, p in sorted(out, key=lambda x: x[0])[:limit]]

@app.get("/api/v1/health")
def health(db: Session = Depends(get_db)):
    """Contrôle de supervision : l'API répond ET la base est joignable. Aucune donnée sensible."""
    try: db.execute(text("SELECT 1"))
    except Exception: raise HTTPException(503, "Base de données indisponible")
    return {"status": "ok"}

# ---------- Assistant IA (texte) : le modèle choisit parmi des lieux PUBLIÉS, il n'écrit rien en base ----------
def published_places(db: Session) -> list[dict]:
    """Lieux de la dernière version PUBLIÉE uniquement. `parent_name` = nom de la racine (le bâtiment) pour lever les ambiguïtés (« chambre 112 »)."""
    mv = db.scalars(select(MapVersion).order_by(MapVersion.version.desc())).first()
    snap = mv.snapshot if mv else []; by = {p["id"]: p for p in snap}; out = []
    for p in snap:
        top, hops = p, 0
        while top.get("parent_id") in by and hops < 8: top = by[top["parent_id"]]; hops += 1
        out.append({**p, "type_label": type_label(p.get("type")), "parent_name": top["name"] if top is not p else None})
    return out
app.include_router(build_router(get_db=get_db, require_user=ANY_USER, get_places=published_places,
                                place_types={c: t.label for c, t in PLACE_TYPES.items()}, get_provider=lambda: ai_provider, get_live=lambda: ai_live, Usage=AiUsage, parent_types={x for t in PLACE_TYPES.values() for x in t.parents},
                                audit=lambda db, who, what: log(db, who, what), client_id=client_ip))
