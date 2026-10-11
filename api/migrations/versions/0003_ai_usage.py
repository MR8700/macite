"""ai_usage : compteurs quotidiens d'appels à l'assistant IA (quota par utilisateur + coupe-circuit global)

Revision ID: 0003
Revises: 0002
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = '0003'
down_revision: Union[str, Sequence[str], None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    op.create_table('ai_usage',
        sa.Column('day', sa.String(), nullable=False), sa.Column('scope', sa.String(), nullable=False),
        sa.Column('count', sa.Integer(), nullable=False, server_default='0'),
        sa.PrimaryKeyConstraint('day', 'scope'))

def downgrade() -> None:
    op.drop_table('ai_usage')
