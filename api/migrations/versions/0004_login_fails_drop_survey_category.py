"""login_fails : verrou de connexion en base ; surveys.category supprimée (doublon de place_type, toujours renseigné)

Revision ID: 0004
Revises: 0003
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = '0004'
down_revision: Union[str, Sequence[str], None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    op.create_table('login_fails',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('key', sa.String(), nullable=False), sa.Column('at', sa.Float(), nullable=False))
    op.create_index('ix_login_fails_key', 'login_fails', ['key']); op.create_index('ix_login_fails_at', 'login_fails', ['at'])
    # Sécurité des données : place_type est calculé et enregistré pour chaque relevé ; on le complète au besoin depuis category avant de supprimer la colonne.
    op.execute("UPDATE surveys SET place_type = category WHERE place_type IS NULL AND category <> ''")
    op.drop_column('surveys', 'category')

def downgrade() -> None:
    op.add_column('surveys', sa.Column('category', sa.String(), nullable=False, server_default=''))
    op.execute("UPDATE surveys SET category = COALESCE(place_type, '')")
    op.drop_index('ix_login_fails_at', 'login_fails'); op.drop_index('ix_login_fails_key', 'login_fails'); op.drop_table('login_fails')
