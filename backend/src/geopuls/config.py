"""Конфигурация приложения. Все параметры задаются переменными окружения с префиксом GEOPULS_."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Настройки сервиса.

    Значения по умолчанию рассчитаны на локальную разработку: БД из docker-compose,
    фронтенд на localhost:3000.
    """

    model_config = SettingsConfigDict(
        env_prefix="GEOPULS_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "ГЕОПУЛЬС API"
    environment: str = "local"
    log_level: str = "INFO"
    git_sha: str | None = None

    # postgresql+asyncpg://<user>:<password>@<host>:<port>/<database>
    database_url: str = "postgresql+asyncpg://geopuls:geopuls@localhost:5432/geopuls"

    # Источники данных (см. docs/tz.md, раздел 2)
    geofabrik_pbf_url: str = "https://download.geofabrik.de/russia/siberian-fed-district-latest.osm.pbf"
    overpass_url: str = "https://overpass-api.de/api/interpreter"

    # Подложка карты отдаётся фронтенду (см. ADR 0002)
    basemap_style_url: str = "https://tiles.openfreemap.org/styles/liberty"

    cors_origins: list[str] = ["http://localhost:3000"]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in {"production", "prod"}


@lru_cache
def get_settings() -> Settings:
    """Настройки как singleton (кэш на процесс)."""
    return Settings()
