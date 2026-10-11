import os; os.environ.update(DATABASE_URL="sqlite:///:memory:?cache=shared", MACITE_SECRET="t", MACITE_RELEVEUR_PASSWORD="r", MACITE_EXPERT_PASSWORD="e", MACITE_ADMIN_PASSWORD="administrateur1")
from sqlalchemy.pool import StaticPool
import main
from sqlalchemy import create_engine, text
PG = os.environ.get("TEST_DATABASE_URL")  # ex. postgresql+psycopg://user:pw@localhost/macite_test : exécute TOUTE la suite sur PostgreSQL/PostGIS
if PG:   # sur PostgreSQL : lancer `pytest test_api.py` et `pytest test_ai.py` SÉPARÉMENT (même base)
    ENGINE = create_engine(PG)
    with ENGINE.begin() as cx: cx.execute(text("DROP SCHEMA public CASCADE")); cx.execute(text("CREATE SCHEMA public"))
else: ENGINE = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
main.engine = ENGINE   # chaque module de test a sa PROPRE base (voir la fixture _db)
from fastapi.testclient import TestClient
c = TestClient(main.app); c.__enter__()
import pytest
@pytest.fixture(scope="module", autouse=True)
def _db():
    main.engine = ENGINE; yield
def tok(u, p): return {"Authorization": "Bearer " + c.post("/api/v1/auth/login", json={"username": u, "password": p}).json()["token"]}
S = lambda i, **k: {"id": i, "kind": "point", "name": "Test synthétique " + i, "points": [[0.0, 0.0]], "accuracies": [3], "version": 1} | k
def test_flow():
    r, e = tok("releveur", "r"), tok("expert", "e")
    assert c.post("/api/v1/sync", json={"surveys": [S("a")]}, headers=r).json()["results"][0]["ok"]
    assert c.post("/api/v1/surveys/a/approve", headers=r).status_code == 403          # permissions insuffisantes
    assert c.get("/api/v1/sites/kossodo/map").json()["places"] == []                       # non validé ≠ officiel
    assert c.post("/api/v1/surveys/a/approve", headers=e).status_code == 200
    assert c.post("/api/v1/map-versions/publish", headers=e).json()["version"] == 1
    assert len(c.get("/api/v1/sites/kossodo/map").json()["places"]) == 1
def test_invalid_and_conflict():
    r = tok("releveur", "r")
    bad = c.post("/api/v1/sync", json={"surveys": [S("b", kind="polygon")]}, headers=r).json()["results"][0]
    assert not bad["ok"]
    assert c.post("/api/v1/sync", json={"surveys": [S("c", points=[[999, 0]])]}, headers=r).status_code == 422
    c.post("/api/v1/sync", json={"surveys": [S("d")]}, headers=r)  # v1 -> serveur v2
    c.post("/api/v1/sync", json={"surveys": [S("d", version=2)]}, headers=r)  # v3
    assert c.post("/api/v1/sync", json={"surveys": [S("d", version=1)]}, headers=r).json()["results"][0].get("conflict")
def test_reject_needs_reason():
    r, e = tok("releveur", "r"), tok("expert", "e")
    c.post("/api/v1/sync", json={"surveys": [S("z")]}, headers=r)
    assert c.post("/api/v1/surveys/z/reject", json={}, headers=e).status_code == 422
    assert c.post("/api/v1/surveys/z/reject", json={"reason": "imprécis"}, headers=e).status_code == 200
def test_no_auth(): assert c.post("/api/v1/sync", json={"surveys": []}).status_code == 401

def test_photos():
    import pathlib, tempfile; main.PHOTO_DIR = pathlib.Path(tempfile.mkdtemp())
    r, e = tok("releveur", "r"), tok("expert", "e"); c.post("/api/v1/sync", json={"surveys": [S("ph")]}, headers=r)
    jpg = b"\xff\xd8\xff" + b"0" * 100
    assert c.post("/api/v1/surveys/ph/photos/p1", files={"file": ("a.jpg", jpg)}, headers=r).status_code == 200
    assert c.post("/api/v1/surveys/ph/photos/p1", files={"file": ("a.jpg", jpg)}, headers=r).json().get("duplicate")
    assert c.post("/api/v1/surveys/ph/photos/p2", files={"file": ("a.jpg", b"GIF89a")}, headers=r).status_code == 415
    assert c.post("/api/v1/surveys/ph/photos/p3", files={"file": ("a.jpg", jpg + b"0" * 2_200_000)}, headers=r).status_code == 413
    assert c.post("/api/v1/surveys/nope/photos/p4", files={"file": ("a.jpg", jpg)}, headers=r).status_code == 404

def test_photo_read_access():
    r, e = tok("releveur", "r"), tok("expert", "e")
    assert c.get("/api/v1/surveys/ph/photos", headers=e).json() == ["p1"]
    assert c.get("/api/v1/surveys/ph/photos/p1", headers=e).content.startswith(b"\xff\xd8\xff")
    assert c.get("/api/v1/surveys/ph/photos/p1").status_code == 401
    assert c.get("/api/v1/surveys/ph/photos/zz", headers=e).status_code == 404

def test_offline_map(tmp_path):
    assert c.get("/api/v1/sites/kossodo/offline-map").status_code == 404
    f = tmp_path / "m.pmtiles"; f.write_bytes(b"x" * 1000); main.OFFLINE_MAP = f
    r = c.get("/api/v1/sites/kossodo/offline-map"); assert r.status_code == 200 and len(r.content) == 1000 and r.headers["etag"]

def test_admin():
    a, r = tok("admin", "administrateur1"), tok("releveur", "r")
    assert c.get("/api/v1/admin/users", headers=r).status_code == 403
    assert c.post("/api/v1/admin/users", json={"username": "x1", "password": "court", "role": "expert"}, headers=a).status_code == 422
    assert c.post("/api/v1/admin/users", json={"username": "nouveau", "password": "motdepasse-long", "role": "releveur"}, headers=a).status_code == 201
    assert c.post("/api/v1/admin/users", json={"username": "nouveau", "password": "motdepasse-long", "role": "releveur"}, headers=a).status_code == 409
    assert c.patch("/api/v1/admin/users/nouveau", json={"active": False}, headers=a).status_code == 200
    assert c.post("/api/v1/auth/login", json={"username": "nouveau", "password": "motdepasse-long"}).status_code == 401   # compte désactivé
    assert c.patch("/api/v1/admin/users/admin", json={"active": False}, headers=a).status_code == 409                    # dernier admin protégé
def test_rollback_and_audit():
    a, e, r = tok("admin", "administrateur1"), tok("expert", "e"), tok("releveur", "r")
    c.post("/api/v1/sync", json={"surveys": [S("rb")]}, headers=r); c.post("/api/v1/surveys/rb/approve", headers=e)
    before = len(c.get("/api/v1/sites/kossodo/map").json()["places"]); v2 = c.post("/api/v1/map-versions/publish", headers=e).json()["version"]
    assert len(c.get("/api/v1/sites/kossodo/map").json()["places"]) == before + 1
    res = c.post("/api/v1/admin/map-versions/1/rollback", headers=a).json()
    assert res["version"] == v2 + 1 and len(c.get("/api/v1/sites/kossodo/map").json()["places"]) == 1   # carte restaurée, historique conservé
    assert c.post("/api/v1/admin/map-versions/99/rollback", headers=a).status_code == 404
    assert any("rollback" in x["what"] for x in c.get("/api/v1/admin/audit", headers=a).json())
    assert c.get("/api/v1/admin/audit", headers=e).status_code == 403

def test_registry_hierarchy_crud():
    e, a = tok("expert", "e"), tok("admin", "administrateur1")
    sq = [[0, 0], [0.0002, 0], [0.0002, 0.0002], [0, 0.0002]]
    P = lambda **k: {"type": "batiment", "name": "Bât test (synthétique)", "kind": "polygon", "points": sq, "pos_source": "carte"} | k
    assert len(c.get("/api/v1/place-types").json()) >= 15
    b = c.post("/api/v1/places", json=P(id="bat1"), headers=e); assert b.status_code == 201
    assert c.post("/api/v1/places", json=P(type="chambre", name="112", id="ch0"), headers=e).status_code == 422             # parent obligatoire
    assert c.post("/api/v1/places", json=P(type="etage", name="R+1", id="et1", parent_id="bat1", level=1), headers=e).status_code == 201
    assert c.post("/api/v1/places", json=P(type="chambre", name="112", id="ch1", parent_id="bat1"), headers=e).status_code == 422   # chambre dans un bâtiment : refusé
    assert c.post("/api/v1/places", json=P(type="chambre", name="112", id="ch1", parent_id="et1", level=1), headers=e).status_code == 201
    assert c.post("/api/v1/places", json=P(type="porte", name="Porte 112", kind="polygon", id="p1", parent_id="ch1"), headers=e).status_code == 422   # géométrie interdite
    assert c.post("/api/v1/places", json=P(type="terrain", name="T", id="t1", parent_id="bat1"), headers=e).status_code == 422     # racine sans parent
    assert c.post("/api/v1/places", json=P(type="batiment", name="Bât", level=2, id="bz"), headers=e).status_code == 422          # pas de niveau
    assert c.patch("/api/v1/places/bat1", json={"parent_id": "ch1"}, headers=e).status_code == 422                               # batiment est racine
    assert [x["id"] for x in c.get("/api/v1/places?parent_id=et1", headers=e).json()] == ["ch1"]
    assert c.patch("/api/v1/places/ch1", json={"name": "Chambre 112"}, headers=e).json()["version"] == 2
    assert c.delete("/api/v1/places/bat1", headers=e).status_code == 403                                                          # archiver : admin
    assert c.delete("/api/v1/places/bat1", headers=a).status_code == 409                                                          # enfants actifs
    for i in ("ch1", "et1", "bat1"): assert c.delete(f"/api/v1/places/{i}", headers=a).status_code == 200
    assert c.get("/api/v1/places/bat1", headers=e).json()["state"] == "archive"
def test_survey_creates_typed_place():
    r, e = tok("releveur", "r"), tok("expert", "e")
    assert not c.post("/api/v1/sync", json={"surveys": [S("sx", place_type="chambre")]}, headers=r).json()["results"][0]["ok"]    # chambre sans parent / géométrie point ok mais parent requis
    assert c.post("/api/v1/sync", json={"surveys": [S("sy", place_type="entree")]}, headers=r).json()["results"][0]["ok"]
    assert c.post("/api/v1/surveys/sy/approve", headers=e).status_code == 200
    assert c.get("/api/v1/places/sy", headers=e).json()["type"] == "entree"

O = 0.00001  # ≈ 1,1 m en degrés
def _bat(e, pid, name, ring=None):
    ring = ring or [[0, 0], [0.0004, 0], [0.0004, 0.0004], [0, 0.0004]]
    assert c.post("/api/v1/places", json={"id": pid, "type": "batiment", "name": name, "kind": "polygon", "points": ring, "pos_source": "carte"}, headers=e).status_code == 201
def test_quality_rules():
    e, r = tok("expert", "e"), tok("releveur", "r")
    _bat(e, "bq", "Bât qualité")
    et = {"id": "eq", "type": "etage", "name": "R+1 q", "kind": "polygon", "points": [[O * 5, O * 5], [O * 30, O * 5], [O * 30, O * 30], [O * 5, O * 30]], "parent_id": "bq", "level": 1}
    assert c.post("/api/v1/places", json=et | {"pos_source": "gps"}, headers=e).status_code == 422                     # GPS sans précision
    assert c.post("/api/v1/places", json=et | {"pos_source": "gps", "acc_m": 40}, headers=e).status_code == 422        # précision insuffisante
    assert c.post("/api/v1/places", json=et | {"pos_source": "gps", "acc_m": 40, "force": True, "reason": "GPS mauvais, vérifié sur plan"}, headers=e).status_code == 201   # dérogation tracée
    assert c.get("/api/v1/places/eq", headers=e).json()["acc_m"] == 40
    out = et | {"id": "eo", "name": "R+2 q", "level": 2, "pos_source": "carte", "points": [[0.01, 0.01], [0.0101, 0.01], [0.0101, 0.0101]]}
    assert "sort de son parent" in c.post("/api/v1/places", json=out, headers=e).text                                    # hors du bâtiment
    assert c.post("/api/v1/places", json=et | {"id": "eq2", "pos_source": "carte"}, headers=e).status_code == 409        # doublon (même nom, même parent)
def test_survey_keeps_provenance():
    r, e = tok("releveur", "r"), tok("expert", "e")
    c.post("/api/v1/sync", json={"surveys": [S("sg", accuracies=[3.0], place_type="repere")]}, headers=r); c.post("/api/v1/surveys/sg/approve", headers=e)
    p = c.get("/api/v1/places/sg", headers=e).json(); assert p["pos_source"] == "gps" and p["acc_m"] == 3.0
    c.post("/api/v1/sync", json={"surveys": [S("sh", accuracies=[60.0])]}, headers=r)
    assert c.post("/api/v1/surveys/sh/approve", headers=e).status_code == 422                                              # précision trop faible
    assert c.post("/api/v1/surveys/sh/approve", json={"force": True, "reason": "sous toit"}, headers=e).status_code == 200
    c.post("/api/v1/sync", json={"surveys": [S("si", accuracies=[None])]}, headers=r); c.post("/api/v1/surveys/si/approve", headers=e)
    assert c.get("/api/v1/places/si", headers=e).json()["pos_source"] == "carte"                                          # posé à la main ≠ GPS
def test_completeness_and_optional_rooms():
    e = tok("expert", "e"); _bat(e, "bc", "Bât complétude")
    assert "Aucune entrée" in " ".join(c.get("/api/v1/places/bc/completeness", headers=e).json()["issues"])
    sq = lambda a: [[O * a, O * a], [O * (a + 20), O * a], [O * (a + 20), O * (a + 20)], [O * a, O * (a + 20)]]
    for pid, lv in (("c0", 0), ("c2", 2)):
        assert c.post("/api/v1/places", json={"id": pid, "type": "etage", "name": f"E{lv}", "kind": "polygon", "points": sq(5), "parent_id": "bc", "level": lv, "pos_source": "carte"}, headers=e).status_code == 201
    j = c.get("/api/v1/places/bc/completeness", headers=e).json()
    assert j["levels"] == [0, 2] and any("Niveaux manquants : 1" in i for i in j["issues"]) and any("aucun escalier" in i for i in j["issues"])
    assert j["optional_rooms"]["conciergerie"] == "inconnu"
    assert c.post("/api/v1/places/bc/declare-absent", json={"type": "conciergerie"}, headers=e).status_code == 200
    assert c.get("/api/v1/places/bc/completeness", headers=e).json()["optional_rooms"]["conciergerie"] == "absent_declare"
    assert c.post("/api/v1/places", json={"id": "cg", "type": "conciergerie", "name": "Conciergerie", "kind": "point", "points": [[O * 10, O * 10]], "parent_id": "c0", "level": 0, "pos_source": "carte"}, headers=e).status_code == 201
    assert c.post("/api/v1/places", json={"id": "mg", "type": "magasin", "name": "Magasin (externe)", "kind": "polygon", "points": sq(500), "pos_source": "carte"}, headers=e).status_code == 201   # externe, sans parent
def test_connectivity_warnings():
    from places import connectivity_warnings as cw
    o = lambda m: m / 111320
    ok = cw([[[0, 0], [o(100), 0]], [[o(101), 0], [o(200), 0]]], [("E1", [o(50), o(5)])]); assert ok == []                 # 1 m d'écart toléré
    bad = cw([[[0, 0], [o(100), 0]], [[o(150), 0], [o(200), 0]]], [("E1", [o(50), o(60)])]); assert len(bad) == 2           # bloc isolé + entrée non reliée
    assert cw([], [("E", [0, 0])])

def test_app_rejects_invalid_polygon_with_422_not_500():
    e = tok("expert", "e"); bow = [[0, 0], [0.0004, 0.0004], [0.0004, 0], [0, 0.0004]]
    r = c.post("/api/v1/places", json={"type": "batiment", "name": "Croisé", "kind": "polygon", "points": bow, "pos_source": "carte"}, headers=e)
    assert r.status_code == 422 and "croise" in r.text
def test_near_search():
    e = tok("expert", "e")
    assert c.post("/api/v1/places", json={"id": "nr1", "type": "point_eau", "name": "Robinet proche", "kind": "point", "points": [[0.5, 0.5]], "pos_source": "carte"}, headers=e).status_code == 201
    near = c.get("/api/v1/places/near/search?lon=0.5&lat=0.5001&radius_m=50", headers=e).json()
    assert [p["id"] for p in near] == ["nr1"] and 8 < near[0]["distance_m"] < 14                       # ≈ 11 m
    assert c.get("/api/v1/places/near/search?lon=0.5&lat=0.6&radius_m=50", headers=e).json() == []
    assert c.get("/api/v1/places/near/search?lon=0.5&lat=99&radius_m=50", headers=e).status_code == 422
import pytest
@pytest.mark.skipif(not PG, reason="PostGIS requis")
def test_postgis_geom_column_and_index():
    with main.engine.connect() as cx:
        assert cx.execute(text("SELECT count(*) FROM places WHERE geom IS NULL")).scalar() == 0                       # trigger : geom toujours remplie
        assert cx.execute(text("SELECT count(*) FROM pg_indexes WHERE indexname='ix_places_geom'")).scalar() == 1     # index GiST présent
        assert cx.execute(text("SELECT ST_GeometryType(geom) FROM places WHERE id='bat1' OR id='bq' LIMIT 1")).scalar() == "ST_Polygon"

def test_health(): assert c.get("/api/v1/health").json() == {"status": "ok"}

def _reset_fails():
    from sqlalchemy import delete
    from sqlalchemy.orm import Session
    with Session(main.engine) as db: db.execute(delete(main.LoginFail)); db.commit()
def test_token_expiry_and_login_throttle():
    import time as _t
    assert c.get("/api/v1/surveys", headers={"Authorization": "Bearer " + main.sign("expert", int(_t.time()) - 10)}).status_code == 401      # expiré
    assert c.get("/api/v1/surveys", headers={"Authorization": "Bearer " + main.sign("expert", int(_t.time()) + 600)}).status_code == 200      # valide
    forged = main.sign("expert", int(_t.time()) + 600).replace("expert", "admin", 1)
    assert c.get("/api/v1/admin/users", headers={"Authorization": "Bearer " + forged}).status_code == 401                                    # forgé
    codes = [c.post("/api/v1/auth/login", json={"username": "releveur", "password": "faux"}).status_code for _ in range(7)]
    assert codes[:5] == [401] * 5 and codes[5:] == [429, 429]                                                                                # blocage après 5 échecs
    assert c.post("/api/v1/auth/login", json={"username": "releveur", "password": "r"}).status_code == 429                                    # même le bon mot de passe est bloqué
    _reset_fails()
    assert c.post("/api/v1/auth/login", json={"username": "releveur", "password": "r"}).status_code == 200
