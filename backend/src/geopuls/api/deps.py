"""Общие зависимости роутеров: сессия БД и метаданные данных."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from geopuls.api.problems import ProblemException
from geopuls.db import create_session_factory


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """Сессия БД из движка приложения (создаётся в lifespan)."""
    engine = getattr(request.app.state, "engine", None)
    if engine is None:
        raise ProblemException(503, "Соединение с базой данных не настроено")

    factory = create_session_factory(engine)
    try:
        async with factory() as session:
            yield session
    except OSError as exc:  # сеть/сокет до Postgres
        raise ProblemException(503, f"База данных недоступна: {exc}") from exc


SessionDep = Annotated[AsyncSession, Depends(get_session)]


@dataclass(frozen=True, slots=True)
class DataVersionInfo:
    """Версия данных и время последнего успешного обновления.

    Показывается пользователю как «данные на <дата>» и участвует в ETag.
    """

    version: str | None
    updated_at: datetime | None


async def load_data_version(session: AsyncSession) -> DataVersionInfo:
    """Актуальная версия данных и время последнего успешного прогона импорта/агрегации."""
    row = (
        (
            await session.execute(
                text(
                    "SELECT (SELECT version FROM data_versions ORDER BY id DESC LIMIT 1) AS version, "
                    "(SELECT max(finished_at) FROM import_runs WHERE status = 'ok') AS updated_at"
                )
            )
        )
        .mappings()
        .one()
    )
    return DataVersionInfo(version=row["version"], updated_at=row["updated_at"])


async def require_city(session: AsyncSession, slug: str) -> dict[str, object]:
    """Проверить, что город существует и активен. Возвращает его основные поля."""
    row = (
        (
            await session.execute(
                text(
                    "SELECT id, slug, name, region, h3_res, boundary IS NOT NULL AS has_boundary "
                    "FROM cities WHERE slug = :slug AND is_active"
                ),
                {"slug": slug},
            )
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise ProblemException(404, f"Город не найден: {slug}")
    return dict(row)


async def require_category(session: AsyncSession, slug: str) -> dict[str, object]:
    """Проверить, что категория существует и активна."""
    row = (
        (
            await session.execute(
                text("SELECT id, slug, name_ru FROM categories WHERE slug = :slug AND is_active"),
                {"slug": slug},
            )
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise ProblemException(404, f"Категория не найдена: {slug}")
    return dict(row)
