"""Расширение PostGIS

Revision ID: 0001
Revises:
Create Date: 2026-09-28

PostGIS нужен раньше таблиц: типы `geography` и функции (ST_GeomFromGeoJSON, ST_DWithin,
ST_PointOnSurface) используются в схеме и в приложении.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")


def downgrade() -> None:
    # Расширение осознанно не удаляем: его могут использовать объекты вне нашей схемы.
    pass
