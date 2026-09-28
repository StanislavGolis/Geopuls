"""Подключение к PostgreSQL/PostGIS.

На Этапе 0 нужен только для проверки готовности (`/readyz`). Модели и миграции — Этап 1.
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

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
