"""Служебные эндпоинты: живость, готовность, версия."""

from __future__ import annotations

import sys
from typing import Any

import h3
from fastapi import APIRouter, Request, Response, status

from geopuls import __version__
from geopuls.db import check_connection

router = APIRouter(tags=["ops"])


def h3_versions() -> dict[str, str]:
    """Версии ядра H3 и Python-обёртки — для диагностики совместимости с фронтендом."""
    try:
        return {key: str(value) for key, value in h3.versions().items()}
    except Exception:  # noqa: BLE001 — диагностика не должна ронять эндпоинт
        return {"python": getattr(h3, "__version__", "unknown")}


@router.get("/healthz", summary="Живость процесса")
async def healthz() -> dict[str, str]:
    """Отвечает без обращения к БД: используется для рестарта контейнера."""
    return {"status": "ok"}


@router.get("/readyz", summary="Готовность: доступность БД")
async def readyz(request: Request, response: Response) -> dict[str, Any]:
    """Проверяет соединение с PostgreSQL. 200 — готов, 503 — нет."""
    engine = getattr(request.app.state, "engine", None)
    if engine is None:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "unavailable", "database": "not_configured"}

    ok, error = await check_connection(engine)
    if not ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "unavailable", "database": "error", "error": error}

    return {"status": "ok", "database": "ok"}


@router.get("/version", summary="Версия приложения и окружения")
async def version(request: Request) -> dict[str, Any]:
    """Версии кода и зависимостей: нужны для приёмки и разбора инцидентов."""
    settings = getattr(request.app.state, "settings", None)
    return {
        "app": getattr(settings, "app_name", "ГЕОПУЛЬС API"),
        "version": __version__,
        "environment": getattr(settings, "environment", "unknown"),
        "git_sha": getattr(settings, "git_sha", None),
        "python": sys.version.split()[0],
        "h3": h3_versions(),
        "basemap_style_url": getattr(settings, "basemap_style_url", None),
    }
