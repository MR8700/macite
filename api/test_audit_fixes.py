"""Tests des corrections issues de l'audit : un test par défaut corrigé (retour des statuts, rollback réel, quotas IA, validations)."""
import os; os.environ.update(DATABASE_URL="sqlite:///:memory:?cache=shared", MACITE_SECRET="t", MACITE_RELEVEUR_PASSWORD="r", MACITE_EXPERT_PASSWORD="e", MACITE_ADMIN_PASSWORD="administrateur1")
import time, types
import pytest
from sqlalchemy import create_engine, delete
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
import main
ENGINE = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
main.engine = ENGINE
from fastapi.testclient import TestClient
from macite_ai import FakeProvider, ProviderError
c = TestClient(main.app); c.__enter__()

@pytest.fixture(scope="module", autouse=True)
def _db():
    main.engine = ENGINE; yield
def tok(u, p): return {"Authorization": "Bearer " + c.post("/api/v1/auth/login", json={"username": u, "password": p}).json()["token"]}
S = lambda i, **k: {"id": i, "kind": "point", "name": "Relevé " + i, "points": [[0.0, 0.0]], "accuracies": [3], "version": 1} | k
SQ = [[0, 0], [0.0002, 0], [0.0002, 0.0002], [0, 0.0002]]
def PL(**k): return {"type": "batiment", "name": "Bât", "kind": "polygon", "points": SQ, "pos_source": "carte"} | k

# ---------- relevés : retour du statut au releveur ----------
def test_sync_returns_version_and_reject_reason_reaches_surveyor():
    r, e = tok("releveur", "r"), tok("expert", "e")
    res = c.post("/api/v1/sync", json={"surveys": [S("rj1")]}, headers=r).json()["results"][0]
    assert res["ok"] and res["version"] == 2                      # le client reprend cette version
    assert c.post("/api/v1/surveys/rj1/reject", json={"reason": "trop imprécis"}, headers=e).status_code == 200
    mine = {x["id"]: x for x in c.get("/api/v1/surveys", headers=r).json()}["rj1"]
    assert mine["status"] == "a_corriger" and mine["reject_reason"] == "trop imprécis"
    # resoumission avec la version renvoyée : accepte (avant : conflit permanent), et efface l'ancien motif
    again = c.post("/api/v1/sync", json={"surveys": [S("rj1", version=2)]}, headers=r).json()["results"][0]
    assert again["ok"] and not again.get("conflict")
    assert {x["id"]: x for x in c.get("/api/v1/surveys", headers=r).json()}["rj1"]["reject_reason"] is None

def test_survey_pagination_is_stable_and_bounded():
    r = tok("releveur", "r"); c.post("/api/v1/sync", json={"surveys": [S("pg1"), S("pg2")]}, headers=r)
    assert c.get("/api/v1/surveys?limit=0", headers=r).status_code == 422 and c.get("/api/v1/surveys?limit=-1", headers=r).status_code == 422
    a = [x["id"] for x in c.get("/api/v1/surveys?limit=1&offset=0", headers=r).json()]; b = [x["id"] for x in c.get("/api/v1/surveys?limit=1&offset=1", headers=r).json()]
    assert a and b and a != b

# ---------- niveau d'étage obligatoire ----------
def test_levelled_types_require_a_level():
    e = tok("expert", "e")
    assert c.post("/api/v1/places", json=PL(id="lv-b", name="Bât niveaux"), headers=e).status_code == 201
    assert c.post("/api/v1/places", json=PL(type="etage", name="Sans niveau", id="lv-e0", parent_id="lv-b"), headers=e).status_code == 422
    assert c.post("/api/v1/places", json=PL(type="etage", name="RDC", id="lv-e1", parent_id="lv-b", level=0), headers=e).status_code == 201   # 0 = RDC reste valide
    r = tok("releveur", "r")
    bad = c.post("/api/v1/sync", json={"surveys": [S("lv-s", kind="polygon", points=SQ, accuracies=[3, 3, 3, 3], place_type="etage", parent_id="lv-b")]}, headers=r).json()["results"][0]
    assert not bad["ok"] and "niveau" in bad["error"]

# ---------- PATCH d'un lieu ----------
def test_patch_validates_coordinates_and_duplicate_rename():
    e = tok("expert", "e")
    c.post("/api/v1/places", json=PL(id="pt-b", name="Bât patch"), headers=e)
    c.post("/api/v1/places", json=PL(type="etage", name="E1", id="pt-e1", parent_id="pt-b", level=1), headers=e)
    c.post("/api/v1/places", json=PL(type="etage", name="E2", id="pt-e2", parent_id="pt-b", level=2), headers=e)
    assert c.patch("/api/v1/places/pt-b", json={"points": [[500, 0], [1, 1], [2, 2]]}, headers=e).status_code == 422       # avant : aucune vérification sur PATCH
    assert c.patch("/api/v1/places/pt-e2", json={"name": "e1"}, headers=e).status_code == 409                               # renommer en doublon (même type, même parent)
    assert c.patch("/api/v1/places/pt-e2", json={"name": "Étage deux"}, headers=e).status_code == 200
    assert c.patch("/api/v1/places/pt-e2", json={"level": 99}, headers=e).status_code == 422

# ---------- rollback : la table de travail est restaurée ----------
def test_rollback_restores_working_places_so_next_publish_is_consistent():
    e, a = tok("expert", "e"), tok("admin", "administrateur1")
    c.post("/api/v1/places", json=PL(id="rb-b", name="Bâtiment RB"), headers=e)
    v1 = c.post("/api/v1/map-versions/publish", headers=e).json()["version"]
    c.post("/api/v1/places", json=PL(type="espace", name="Cour RB", id="rb-cour"), headers=e)
    c.patch("/api/v1/places/rb-b", json={"name": "Bâtiment RB renommé"}, headers=e)
    v2 = c.post("/api/v1/map-versions/publish", headers=e).json()["version"]
    assert v2 == v1 + 1
    n = c.post(f"/api/v1/admin/map-versions/{v1}/rollback", headers=a).json()["version"]
    pub = {p["id"]: p for p in c.get("/api/v1/sites/kossodo/map").json()["places"]}
    assert pub["rb-b"]["name"] == "Bâtiment RB" and "rb-cour" not in pub
    live = {p["id"]: p for p in c.get("/api/v1/places", headers=e).json()}
    assert live["rb-b"]["name"] == "Bâtiment RB" and "rb-cour" not in live       # la table de travail suit (avant : elle gardait l'état d'après)
    again = c.post("/api/v1/map-versions/publish", headers=e)
    assert again.status_code == 409 and n == v2 + 1                              # rien de nouveau : la restauration n'est pas défaite par la publication suivante

# ---------- connexion ----------
def _reset_fails():
    with Session(ENGINE) as db: db.execute(delete(main.LoginFail)); db.commit()
def test_login_lock_table_is_bounded():
    _reset_fails()
    with Session(ENGINE) as db:
        db.add_all([main.LoginFail(key=f"u:1.1.1.1|inconnu{i}", at=time.time() - main.WINDOW - 5) for i in range(1100)]); db.commit()
    c.post("/api/v1/auth/login", json={"username": "x", "password": "y"})
    with Session(ENGINE) as db: assert db.query(main.LoginFail).count() <= 2   # entrées expirées purgées ; il ne reste que l'échec qui vient d'avoir lieu (couple + adresse)

def test_verrou_partage_entre_workers():
    """Le compteur est en base : un second « processus » (nouvelle session, état mémoire vierge) voit les mêmes échecs."""
    _reset_fails()
    for _ in range(5): assert c.post("/api/v1/auth/login", json={"username": "releveur", "password": "faux"}).status_code == 401
    with Session(ENGINE) as other_worker: assert main._fail_count(other_worker, "u:testclient|releveur", time.time()) == 5
    assert c.post("/api/v1/auth/login", json={"username": "releveur", "password": "r"}).status_code == 429
    _reset_fails()

# ---------- photos ----------
def test_photo_id_validation():
    r = tok("releveur", "r"); jpg = b"\xff\xd8\xff" + b"0" * 20
    c.post("/api/v1/sync", json={"surveys": [S("ph1")]}, headers=r)
    for bad in ("a_b", "x" * 80, "a%20b"):
        assert c.post(f"/api/v1/surveys/ph1/photos/{bad}", files={"file": ("a.jpg", jpg, "image/jpeg")}, headers=r).status_code == 422
    ok = c.post("/api/v1/surveys/ph1/photos/p-1", files={"file": ("a.jpg", jpg, "image/jpeg")}, headers=r); assert ok.status_code == 200
    c.post("/api/v1/sync", json={"surveys": [S("ph2")]}, headers=r)
    assert c.post("/api/v1/surveys/ph2/photos/p-1", files={"file": ("a.jpg", jpg, "image/jpeg")}, headers=r).status_code == 409   # identifiant déjà pris par un autre relevé

# ---------- publication : connectivité cohérente avec l'application ----------
def test_connectivity_uses_path_ends_like_the_client():
    from places import connectivity_warnings as cw
    o = lambda m: m / 111320
    # Chemin B dont un SOMMET INTERMÉDIAIRE frôle A mais dont les extrémités sont loin : le client ne les relie pas, la publication doit le dire.
    A = [[0, 0], [o(100), 0]]; B = [[o(50), o(40)], [o(50), o(1)], [o(50), o(40) * -1]]
    assert any("déconnecté" in w for w in cw([A, B], []))
    # Jonction en T par l'extrémité : reliée.
    T = [[o(50), o(30)], [o(50), o(1)]]
    assert cw([A, T], []) == []

# ---------- quotas IA ----------
from fastapi import FastAPI
from sqlalchemy.orm import declarative_base
from macite_ai import build_router, make_usage_model
_B = declarative_base(); _U = make_usage_model(_B)
_E = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool); _B.metadata.create_all(_E)
_H = types.SimpleNamespace(prov=None)
def _gdb():
    with Session(_E) as s: yield s
_PL = [{"id": "p1", "name": "Bâtiment D3", "type_label": "Bâtiment", "type": "batiment", "level": None, "number": "D3", "parent_id": None, "parent_name": None, "points": [[-1.5, 12.4]]}]
_app = FastAPI()
_app.include_router(build_router(get_db=_gdb, require_user=lambda: types.SimpleNamespace(username="alice"), get_places=lambda db: _PL, place_types={"batiment": "Bâtiment"},
                                 get_provider=lambda: _H.prov, Usage=_U, per_user=3, global_limit=10))
q = TestClient(_app)
@pytest.fixture
def _clean():
    with Session(_E) as s: s.execute(delete(_U)); s.commit()
    yield
def _used():
    with Session(_E) as s:
        import time as _t; row = s.get(_U, (_t.strftime("%Y-%m-%d", _t.gmtime()), "u:alice")); return row.count if row else 0

def test_provider_outage_does_not_consume_text_quota(_clean):
    _H.prov = FakeProvider([ProviderError("panne")])
    r = q.post("/api/v1/ai/chat", json={"message": "bâtiment D3", "ack": True}).json()
    assert r["degraded"] and r["action"] == "show_place"            # repli sans IA, la demande est quand même servie
    assert _used() == 0                                              # et la tentative échouée n'est pas décomptée (comme pour la voix)
    _H.prov = FakeProvider([ProviderError("panne")])
    assert q.post("/api/v1/ai/survey-draft", json={"text": "bâtiment D3", "ack": True}).json()["degraded"] and _used() == 0

def test_unusable_but_received_answer_is_still_counted(_clean):
    _H.prov = FakeProvider(["pas du json"])
    assert q.post("/api/v1/ai/chat", json={"message": "bâtiment D3", "ack": True}).json()["degraded"] and _used() == 1   # Google a répondu (et facturé)

def test_empty_query_spends_nothing_and_never_calls_the_model(_clean):
    _H.prov = FakeProvider([{"action": "not_found"}])
    r = q.post("/api/v1/ai/chat", json={"message": "le la ?!", "ack": True}).json()
    assert r["action"] == "not_found" and _used() == 0 and _H.prov.calls == []

def test_usage_endpoint_reports_remaining_text_quota(_clean):
    assert q.get("/api/v1/ai/usage").json()["remaining"] == 3
    _H.prov = FakeProvider([{"action": "not_found"}]); q.post("/api/v1/ai/chat", json={"message": "D3", "ack": True})
    j = q.get("/api/v1/ai/usage").json(); assert (j["used"], j["limit"], j["remaining"]) == (1, 3, 2)

def test_default_limits_match_documented_env_example(monkeypatch):
    monkeypatch.delenv("MACITE_AI_DAILY_PER_USER", raising=False); monkeypatch.delenv("MACITE_AI_DAILY_GLOBAL", raising=False)
    a = FastAPI(); a.include_router(build_router(get_db=_gdb, require_user=lambda: types.SimpleNamespace(username="bob"), get_places=lambda db: _PL, place_types={"batiment": "Bâtiment"}, get_provider=lambda: None, Usage=_U))
    assert TestClient(a).get("/api/v1/ai/usage").json()["limit"] == 20      # .env.example : 20 / utilisateur (le code disait 50, et 2000 global au lieu de 400)

def test_fake_provider_refused_in_production(monkeypatch):
    from macite_ai import provider_from_env
    monkeypatch.setenv("MACITE_AI_PROVIDER", "fake"); monkeypatch.setenv("MACITE_ENV", "production")
    with pytest.raises(RuntimeError): provider_from_env()
    monkeypatch.setenv("MACITE_ENV", "development"); assert provider_from_env() is not None

# ---------- registre des types : le miroir web ne doit pas dériver ----------
def test_web_place_types_mirror_matches_server_registry():
    """web/src/lib/placeTypes.ts recopie à la main api/places.py. Ce test échoue dès qu'un type, un parent, un niveau ou une géométrie diverge."""
    import re
    from pathlib import Path
    from places import PLACE_TYPES
    src = (Path(__file__).parent.parent / "web" / "src" / "lib" / "placeTypes.ts").read_text(encoding="utf-8")
    web = {}
    for m in re.finditer(r"^\s*(\w+): \{ label: '[^']*', kinds: \[([^\]]*)\], parents: \[([^\]]*)\](, parentRequired: true)?(, levelled: true)? \}", src, re.M):
        web[m.group(1)] = (frozenset(re.findall(r"'(\w+)'", m.group(2))), frozenset(re.findall(r"'(\w+)'", m.group(3))), bool(m.group(4)), bool(m.group(5)))
    loop = src[src.index("Object.fromEntries"):src.index("as const")]
    for code in re.findall(r"\['(\w+)', '[^']*'\]", loop):   # pièces facultatives générées en boucle côté web
        web[code] = (frozenset({"polygon", "point"}), frozenset({"batiment", "aile", "etage"}), True, True)
    server = {c: (frozenset(t.kinds), frozenset(t.parents), t.parent_required, t.levelled) for c, t in PLACE_TYPES.items()}
    assert set(web) == set(server), f"types seulement d'un côté : {set(web) ^ set(server)}"
    assert {c: v for c, v in web.items() if v != server[c]} == {}, "règles divergentes entre placeTypes.ts et places.py"


# ---------- Lot B : sécurité et cohérence (corrections de la section B de l'audit) ----------
def test_sel_par_utilisateur_et_migration_ancien_format():
    import main
    a, b = main.hpw("motdepasse-identique"), main.hpw("motdepasse-identique")
    assert a != b and a.startswith("pbkdf2$") and main.check_pw(a, "motdepasse-identique") and not main.check_pw(a, "autre")
    legacy = main._legacy_hpw("ancien-mot-de-passe")   # empreinte d'avant la correction : doit rester acceptée puis être migrée
    assert main.check_pw(legacy, "ancien-mot-de-passe") and not main.check_pw(legacy, "x")
    assert not main.check_pw("pbkdf2$zz$zz", "x")   # empreinte mal formée : refus, pas d'exception

def test_changement_et_reinitialisation_du_mot_de_passe():
    a = tok("administrateur_"[:0] + "admin", "administrateur1")
    assert c.post("/api/v1/admin/users", json={"username": "pwuser", "password": "premier-mdp-10", "role": "releveur"}, headers=a).status_code == 201
    u = tok("pwuser", "premier-mdp-10")
    assert c.post("/api/v1/auth/password", json={"current": "faux", "new": "second-mdp-1234"}, headers=u).status_code == 403
    assert c.post("/api/v1/auth/password", json={"current": "premier-mdp-10", "new": "court"}, headers=u).status_code == 422
    assert c.post("/api/v1/auth/password", json={"current": "premier-mdp-10", "new": "second-mdp-1234"}, headers=u).status_code == 200
    assert c.post("/api/v1/auth/login", json={"username": "pwuser", "password": "premier-mdp-10"}).status_code == 401
    assert c.post("/api/v1/auth/login", json={"username": "pwuser", "password": "second-mdp-1234"}).status_code == 200
    assert c.post("/api/v1/admin/users/pwuser/password", json={"new": "reinit-par-admin-1"}, headers=u).status_code == 403   # réservé à l'admin
    assert c.post("/api/v1/admin/users/pwuser/password", json={"new": "reinit-par-admin-1"}, headers=a).status_code == 200
    assert c.post("/api/v1/auth/login", json={"username": "pwuser", "password": "reinit-par-admin-1"}).status_code == 200

def test_ancien_hachage_migre_a_la_connexion():
    with Session(ENGINE) as db:
        db.add(main.User(username="vieux", pw=main._legacy_hpw("ancien-mdp-123"), role="releveur", active=True)); db.commit()
    assert c.post("/api/v1/auth/login", json={"username": "vieux", "password": "ancien-mdp-123"}).status_code == 200
    with Session(ENGINE) as db: assert db.get(main.User, "vieux").pw.startswith("pbkdf2$")
    assert c.post("/api/v1/auth/login", json={"username": "vieux", "password": "ancien-mdp-123"}).status_code == 200

def test_site_inconnu_et_photo_sur_releve_valide():
    assert c.get("/api/v1/sites/autre/map").status_code == 404 and c.get("/api/v1/sites/kossodo/map").status_code == 200
    r, e = tok("releveur", "r"), tok("expert", "e")
    c.post("/api/v1/sync", json={"surveys": [S("phv1")]}, headers=r)
    jpg = b"\xff\xd8\xff" + b"0" * 50
    assert c.post("/api/v1/surveys/phv1/photos/a1", files={"file": ("a.jpg", jpg, "image/jpeg")}, headers=r).status_code == 200
    assert c.post("/api/v1/surveys/phv1/approve", headers=e).status_code == 200
    assert c.post("/api/v1/surveys/phv1/photos/a2", files={"file": ("a.jpg", jpg, "image/jpeg")}, headers=r).status_code == 409

def test_recherche_publique_limitee_par_client(monkeypatch):
    monkeypatch.setenv("MACITE_SEARCH_PER_MIN", "3")
    from fastapi import FastAPI
    from macite_ai import build_router
    app2 = FastAPI(); app2.include_router(build_router(get_db=main.get_db, require_user=main.ANY_USER, get_places=lambda db: [], place_types={}, get_provider=lambda: None, Usage=main.AiUsage))
    c2 = TestClient(app2)
    codes = [c2.get("/api/v1/search?q=bat").status_code for _ in range(5)]
    assert codes == [200, 200, 200, 429, 429]

def test_verrou_par_adresse_et_identifiant():
    _reset_fails()
    atk = {"x-forwarded-for": "1.1.1.1"}
    # sans confiance au proxy, l'en-tête est ignoré : même client => même verrou (comportement historique)
    for _ in range(5): assert c.post("/api/v1/auth/login", json={"username": "releveur", "password": "faux"}).status_code == 401
    assert c.post("/api/v1/auth/login", json={"username": "releveur", "password": "r"}).status_code == 429
    main.TRUST_PROXY = True
    try:   # derrière Caddy : un autre client (autre adresse) n'est pas bloqué par les échecs du premier
        assert c.post("/api/v1/auth/login", json={"username": "releveur", "password": "r"}, headers={"x-forwarded-for": "9.9.9.9, 2.2.2.2"}).status_code == 200
        for _ in range(5): c.post("/api/v1/auth/login", json={"username": "expert", "password": "faux"}, headers=atk)
        assert c.post("/api/v1/auth/login", json={"username": "expert", "password": "e"}, headers=atk).status_code == 429          # l'attaquant est bloqué
        assert c.post("/api/v1/auth/login", json={"username": "expert", "password": "e"}, headers={"x-forwarded-for": "3.3.3.3"}).status_code == 200   # pas la victime
    finally: main.TRUST_PROXY = False; _reset_fails()

def test_comptes_environnement_resynchronises_sur_option(monkeypatch):
    monkeypatch.setenv("MACITE_RELEVEUR_PASSWORD", "nouveau-mdp-env")
    main.init()
    assert c.post("/api/v1/auth/login", json={"username": "releveur", "password": "r"}).status_code == 200   # défaut : pas d'écrasement
    monkeypatch.setattr(main, "SYNC_ENV_PW", True); main.init()
    assert c.post("/api/v1/auth/login", json={"username": "releveur", "password": "nouveau-mdp-env"}).status_code == 200
    assert c.post("/api/v1/auth/login", json={"username": "releveur", "password": "r"}).status_code == 401
    with Session(ENGINE) as db: db.get(main.User, "releveur").pw = main.hpw("r"); db.commit()   # remet l'état initial pour les tests suivants
    _reset_fails()

def test_type_label_remplace_category():
    r, e, a = tok("releveur", "r"), tok("expert", "e"), tok("admin", "administrateur1")
    # un relevé ne porte plus de « category » : seul place_type fait foi ; un ancien client qui l'envoie encore est toléré (champ ignoré)
    res = c.post("/api/v1/sync", json={"surveys": [S("tl1", place_type="entree", category="n'importe quoi")]}, headers=r).json()["results"][0]; assert res["ok"]
    row = {x["id"]: x for x in c.get("/api/v1/surveys", headers=r).json()}["tl1"]; assert row["place_type"] == "entree" and "category" not in row
    c.post("/api/v1/surveys/tl1/approve", headers=e)
    assert [p for p in c.get("/api/v1/places", headers=e).json() if p["id"] == "tl1"][0]["type_label"] == main.type_label("entree") and "category" not in c.get("/api/v1/places/tl1", headers=e).json()
    c.post("/api/v1/map-versions/publish", headers=e)
    pl = [p for p in c.get("/api/v1/sites/kossodo/map").json()["places"] if p["id"] == "tl1"][0]
    assert pl["type_label"] == main.type_label("entree") and pl["category"] == pl["type_label"]   # alias transitoire pour les applications déjà installées
    # un ancien instantané (stocké avec la clé « category » et sans type_label) reste exploitable : le libellé est dérivé du type
    with Session(ENGINE) as db:
        db.add(main.MapVersion(version=999, created_by="t", at=time.time(), snapshot=[{"id": "old1", "type": "batiment", "category": "Bâtiment", "name": "Vieux", "kind": "point", "points": [[0, 0]], "parent_id": None}])); db.commit()
        got = main.published_places(db)
        assert got[0]["type_label"] == main.type_label("batiment") == "Bâtiment"
        db.delete(db.get(main.MapVersion, 999)); db.commit()

def test_migration_0004_sur_sqlite():
    import importlib.util, sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    spec = importlib.util.spec_from_file_location("m4", "migrations/versions/0004_login_fails_drop_survey_category.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    eng = sa.create_engine("sqlite://")
    with eng.begin() as cx:
        cx.execute(sa.text("CREATE TABLE surveys (id TEXT PRIMARY KEY, category TEXT NOT NULL DEFAULT '', place_type TEXT)"))
        cx.execute(sa.text("INSERT INTO surveys VALUES ('a','chambre',NULL),('b','','entree')"))
        with Operations.context(MigrationContext.configure(cx)): m.upgrade()
        assert [tuple(r) for r in cx.execute(sa.text("SELECT id, place_type FROM surveys ORDER BY id"))] == [("a", "chambre"), ("b", "entree")]   # rien de perdu
        assert "category" not in [col["name"] for col in sa.inspect(cx).get_columns("surveys")] and sa.inspect(cx).has_table("login_fails")
        with Operations.context(MigrationContext.configure(cx)): m.downgrade()
        assert "category" in [col["name"] for col in sa.inspect(cx).get_columns("surveys")] and not sa.inspect(cx).has_table("login_fails")

def test_identifiant_de_releve_sans_traversee_de_repertoire():
    r = tok("releveur", "r")
    for bad in ("..", "../x", "a/b", "a b", ""):
        assert c.post("/api/v1/sync", json={"surveys": [S("x")|{"id": bad}]}, headers=r).status_code == 422
    assert c.post("/api/v1/sync", json={"surveys": [S("ok-1_A")]}, headers=r).json()["results"][0]["ok"]
    # défense en profondeur : un ancien relevé déjà en base avec un identifiant dangereux ne permet pas d'écrire hors du dossier des photos
    with Session(ENGINE) as db:
        db.add(main.SurveyRow(id="..", owner="releveur", kind="point", name="legacy", points=[[0, 0]], accuracies=[3], status="a_verifier", version=1)); db.commit()
    assert c.post("/api/v1/surveys/%2e%2e/photos/evil", files={"file": ("a.jpg", b"\xff\xd8\xff" + b"0" * 20, "image/jpeg")}, headers=r).status_code in (404, 422)
    with Session(ENGINE) as db: db.delete(db.get(main.SurveyRow, "..")); db.commit()

def test_recherche_limitee_par_adresse_reelle_derriere_le_proxy(monkeypatch):
    monkeypatch.setenv("MACITE_SEARCH_PER_MIN", "2")
    from fastapi import FastAPI
    from macite_ai import build_router
    app2 = FastAPI(); app2.include_router(build_router(get_db=main.get_db, require_user=main.ANY_USER, get_places=lambda db: [], place_types={}, get_provider=lambda: None, Usage=main.AiUsage, client_id=main.client_ip))
    c2 = TestClient(app2); main.TRUST_PROXY = True
    try:
        h = lambda ip: {"x-forwarded-for": ip}
        assert [c2.get("/api/v1/search?q=a", headers=h("1.1.1.1")).status_code for _ in range(3)] == [200, 200, 429]
        assert c2.get("/api/v1/search?q=a", headers=h("2.2.2.2")).status_code == 200   # un autre visiteur n'est pas pénalisé par le premier
    finally: main.TRUST_PROXY = False
