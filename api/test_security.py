import pytest
from security import load_secret, secret_problem, is_production, MIN_SECRET_LEN

GOOD = "k7Qx2mVb9LpR4tYw8NzC1dFh6JsA3eUg5oIvXyZq0B"
def test_production_refuses_missing_or_weak_secret():
    for env in ({"MACITE_ENV": "production"}, {"MACITE_ENV": "production", "MACITE_SECRET": ""}, {"MACITE_ENV": "production", "MACITE_SECRET": "   "},
                {"MACITE_ENV": "production", "MACITE_SECRET": "court"}, {"MACITE_ENV": "prod", "MACITE_SECRET": "x" * 40},
                {"MACITE_ENV": "Production", "MACITE_SECRET": "changez-moi-longue-valeur-aleatoire"}, {"MACITE_ENV": "production", "MACITE_SECRET": "a" * (MIN_SECRET_LEN - 1)}):
        with pytest.raises(RuntimeError) as e: load_secret(env)
        assert "MACITE_SECRET" in str(e.value) and "démarrage refusé" in str(e.value)
def test_production_accepts_strong_secret():
    assert load_secret({"MACITE_ENV": "production", "MACITE_SECRET": GOOD}) == GOOD and load_secret({"MACITE_ENV": "prod", "MACITE_SECRET": f"  {GOOD}  "}) == GOOD
def test_development_falls_back_to_random_secret():
    a, b = load_secret({}), load_secret({}); assert len(a) >= 32 and a != b
    assert load_secret({"MACITE_SECRET": "dev"}) == "dev"
def test_helpers():
    assert is_production({"MACITE_ENV": "production"}) and not is_production({}) and not is_production({"MACITE_ENV": "development"})
    assert secret_problem(GOOD) is None and secret_problem("") == "absent"
def test_error_message_never_contains_the_secret():
    bad = "changez-moi-et-ceci-est-un-secret-trop-long-123"
    with pytest.raises(RuntimeError) as e: load_secret({"MACITE_ENV": "production", "MACITE_SECRET": bad})
    assert bad not in str(e.value)
