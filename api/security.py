"""Secret de signature des sessions MaCité : en production, on REFUSE de démarrer s'il est absent ou faible."""
import os, secrets

MIN_SECRET_LEN = 32
_PLACEHOLDERS = ("changez-moi", "change-me", "changeme", "secret", "password", "motdepasse", "exemple", "example")

def is_production(env=None) -> bool:
    return (os.environ if env is None else env).get("MACITE_ENV", "development").strip().lower() in ("production", "prod")

def secret_problem(value: str):
    """Motif de faiblesse (sans jamais citer la valeur), ou None."""
    v = (value or "").strip()
    if not v: return "absent"
    if len(v) < MIN_SECRET_LEN: return f"trop court (minimum {MIN_SECRET_LEN} caractères)"
    if v.lower().startswith(_PLACEHOLDERS) or len(set(v)) < 8: return "valeur d'exemple ou trop répétitive"
    return None

def load_secret(env=None) -> str:
    env = os.environ if env is None else env
    value = env.get("MACITE_SECRET", "").strip()
    if is_production(env):
        problem = secret_problem(value)
        if problem: raise RuntimeError(f"MACITE_SECRET {problem} : démarrage refusé en production. Générer une valeur avec : python -c \"import secrets; print(secrets.token_urlsafe(48))\"")
        return value
    return value or secrets.token_hex(16)   # développement : secret aléatoire à chaque démarrage (les sessions ne survivent pas au redémarrage)
