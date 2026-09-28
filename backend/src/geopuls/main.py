"""Точка входа FastAPI-приложения ГЕОПУЛЬС."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from geopuls import __version__
from geopuls.api.health import router as health_router
from geopuls.config import Settings, get_settings
from geopuls.db import create_engine

logger = logging.getLogger(__name__)


def configure_logging(settings: Settings) -> None:
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    """Собрать приложение (фабрика — удобна для тестов и нескольких окружений)."""
    settings = settings or get_settings()
    configure_logging(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings
        app.state.engine = create_engine(settings)
        logger.info(
            "ГЕОПУЛЬС API запущен: version=%s environment=%s",
            __version__,
            settings.environment,
        )
        try:
            yield
        finally:
            await app.state.engine.dispose()
            logger.info("ГЕОПУЛЬС API остановлен")

    app = FastAPI(
        title=settings.app_name,
        version=__version__,
        summary="Тепловые карты плотности организаций по открытым данным OSM",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "HEAD", "OPTIONS"],
        allow_headers=["*"],
    )
    app.include_router(health_router)

    @app.get("/", include_in_schema=False)
    async def root() -> RedirectResponse:
        return RedirectResponse(url="/docs")

    return app


app = create_app()
