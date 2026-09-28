"""Подключение к PostgreSQL/PostGIS."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from geopuls.config import Settings

logger = logging.getLogger(__name__)


def create_engine(settings: Settings) -> AsyncEngine:
    """Создать асинхронный движок SQLAlchemy."""
    return create_async_engine(
        settings.database_url,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
        echo=False,
    )


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Фабрика сессий: `expire_on_commit=False` — объекты остаются читаемыми после коммита."""
    return async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


@asynccontextmanager
async def session_scope(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    """Сессия с автоматическим откатом при ошибке — для CLI-задач (сид, импорт)."""
    factory = create_session_factory(engine)
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def check_connection(engine: AsyncEngine) -> tuple[bool, str | None]:
    """Проверить соединение с БД.

    Возвращает ``(True, None)`` при успехе и ``(False, "причина")`` при ошибке —
    без исключений, чтобы `/readyz` всегда отвечал по схеме.
    """
    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 — причина возвращается наружу текстом
        logger.warning("Проверка соединения с БД не удалась: %s", exc)
        return False, f"{type(exc).__name__}: {exc}"
    return True, None
