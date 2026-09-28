"""Декларативная база моделей.

Имена ограничений задаются явно (naming convention): иначе Alembic генерирует безымянные
constraints, которые потом невозможно корректно изменить или удалить.
"""

from __future__ import annotations

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """Общая база всех моделей ГЕОПУЛЬС."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)
