from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

def make_usage_model(Base):
    """Table des compteurs d'appels au fournisseur d'IA, par jour (UTC) et par portée (u:<utilisateur> | global)."""
    class AiUsage(Base):
        __tablename__ = "ai_usage"
        day: Mapped[str] = mapped_column(String, primary_key=True)
        scope: Mapped[str] = mapped_column(String, primary_key=True)
        count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    return AiUsage
