import sqlalchemy as sa
from alembic import op

revision = "0001"


def upgrade():
    op.create_table(
        "authors",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False, unique=True),
    )
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event", sa.String(40)),
    )
    op.add_column("authors", sa.Column("bio", sa.String(), nullable=True))
    op.execute("UPDATE authors SET bio = '' WHERE bio IS NULL")


def downgrade():
    op.drop_column("authors", "bio")
    op.drop_table("audit_log")
