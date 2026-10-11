"""Assistant IA branché sur l'API réelle : droits, lieux PUBLIÉS uniquement, quotas, audit sans texte utilisateur."""
import os; os.environ.update(DATABASE_URL="sqlite:///:memory:?cache=shared", MACITE_SECRET="t", MACITE_RELEVEUR_PASSWORD="r", MACITE_EXPERT_PASSWORD="e", MACITE_ADMIN_PASSWORD="administrateur1")
import time, pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
import main
from macite_ai import FakeProvider, ProviderError
PG = os.environ.get("TEST_DATABASE_URL")
if PG:   # sur PostgreSQL : lancer `pytest test_ai.py` SÉPARÉMENT de test_api.py (même base)
    ENGINE = create_engine(PG)
    with ENGINE.begin() as cx: cx.execute(text("DROP SCHEMA public CASCADE")); cx.execute(text("CREATE SCHEMA public"))
else: ENGINE = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
main.engine = ENGINE
from fastapi.testclient import TestClient
c = TestClient(main.app); c.__enter__()
@pytest.fixture(scope="module", autouse=True)
def _db():
    main.engine = ENGINE; yield
def tok(u, p): return {"Authorization": "Bearer " + c.post("/api/v1/auth/login", json={"username": u, "password": p}).json()["token"]}
def P(i, name, typ, cat, **k): return {"id": i, "type": typ, "type_label": cat, "name": name, "number": None, "kind": "point", "points": [[-1.5, 12.4]], "parent_id": None, "level": None, **k}
SNAP = [P("b1", "Bâtiment D3", "batiment", "Bâtiment", kind="polygon"), P("e1", "Étage 1", "etage", "Étage", parent_id="b1", level=1, kind="polygon"),
        P("c1", "Chambre 112", "chambre", "Chambre", parent_id="e1", level=1, number="112"), P("t1", "Terrain omnisport", "terrain", "Terrain de sport", kind="polygon")]
@pytest.fixture(autouse=True)
def _reset():
    main.ai_provider = FakeProvider()
    with Session(ENGINE) as s:
        s.query(main.AiUsage).delete(); s.query(main.MapVersion).delete()
        s.add(main.MapVersion(version=1, created_by="x", at=time.time(), snapshot=SNAP)); s.commit()
def chat(msg, h=None, ack=True): return c.post("/api/v1/ai/chat", json={"message": msg, "ack": ack}, headers=h if h is not None else tok("releveur", "r"))

def test_auth_and_consent():
    assert c.post("/api/v1/ai/chat", json={"message": "x", "ack": True}).status_code == 401
    assert c.post("/api/v1/ai/survey-draft", json={"text": "x", "ack": True}).status_code == 401
    assert chat("D3", ack=False).status_code == 422
    main.ai_provider = None; assert chat("D3").status_code == 503 and c.get("/api/v1/ai/status").json() == {"enabled": False}
def test_search_public_and_parent_is_building():
    j = c.get("/api/v1/search", params={"q": "chambre 112"}).json(); assert j[0]["id"] == "c1" and j[0]["parent_name"] == "Bâtiment D3"
    assert c.get("/api/v1/search", params={"q": "terain omni"}).json()[0]["id"] == "t1"
def test_only_published_places_are_visible():
    with Session(ENGINE) as s: s.query(main.MapVersion).delete(); s.commit()
    assert c.get("/api/v1/search", params={"q": "D3"}).json() == []
    main.ai_provider = FakeProvider([{"action": "show_place", "place_id": "b1"}]); j = chat("D3").json()
    assert j["action"] == "not_found" or j["degraded"]
def test_chat_flow_quota_and_audit_without_user_text():
    main.ai_provider = FakeProvider([{"action": "show_place", "place_id": "c1"}]); j = chat("secretXYZ chambre 112").json()
    assert j["action"] == "show_place" and j["place"]["id"] == "c1" and "Bâtiment D3" in j["message"] and not j["degraded"]
    with Session(ENGINE) as s:
        assert {r.scope: r.count for r in s.scalars(select(main.AiUsage))} == {"u:releveur": 1, "global": 1}
        whats = [a.what for a in s.scalars(select(main.Audit))]
    assert any(w.startswith("ai show_place c1") for w in whats) and not any("secretXYZ" in w for w in whats)
def test_provider_failure_degrades_without_500():
    main.ai_provider = FakeProvider([ProviderError("HTTPStatusError")]); j = chat("terrain omnisport")
    assert j.status_code == 200 and j.json()["degraded"] and j.json()["place"]["id"] == "t1"
def test_user_quota_enforced_by_env_limits():
    # limites par défaut (50) : on force un compteur proche de la limite
    with Session(ENGINE) as s: s.add(main.AiUsage(day=time.strftime("%Y-%m-%d", time.gmtime()), scope="u:releveur", count=50)); s.commit()
    assert chat("D3").status_code == 429
    assert chat("D3", tok("expert", "e")).status_code in (200,)           # un autre utilisateur n'est pas bloqué
def test_survey_draft_via_api():
    main.ai_provider = FakeProvider([{"name": "Chambre 113", "type": "chambre", "parent_id": "e1", "notes": "porte bleue", "lat": 9}])
    j = c.post("/api/v1/ai/survey-draft", json={"text": "chambre 113 étage 1 porte bleue", "ack": True}, headers=tok("releveur", "r")).json()
    assert j["draft"]["type"] == "chambre" and j["draft"]["parent_id"] == "e1" and "lat" not in j["draft"]
def test_existing_api_untouched():
    assert c.get("/api/v1/health").json() == {"status": "ok"} and len(c.get("/api/v1/sites/kossodo/map").json()["places"]) == 4
