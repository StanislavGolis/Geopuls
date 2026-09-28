"""Тесты служебных эндпоинтов (Этап 0).

Тесты, требующие живой БД, включаются только в CI (переменная GEOPULS_CI_DB=1
и настроенный GEOPULS_DATABASE_URL) — локальный прогон остаётся без зависимостей.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from geopuls import __version__
from geopuls.main import app

DB_IS_AVAILABLE = os.getenv("GEOPULS_CI_DB") == "1"


def test_healthz() -> None:
    with TestClient(app) as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_version_reports_h3_and_python() -> None:
    with TestClient(app) as client:
        response = client.get("/version")

    assert response.status_code == 200
    body = response.json()
    assert body["version"] == __version__
    assert body["python"]
    assert "c" in body["h3"], "версия ядра H3 обязана быть видна в /version"
    # Ядро H3 на бэкенде и фронтенде должно совпадать (см. ADR 0001)
    assert body["h3"]["c"].startswith("4.")


def test_root_redirects_to_docs() -> None:
    with TestClient(app) as client:
        response = client.get("/", follow_redirects=False)

    assert response.status_code in (307, 308)
    assert response.headers["location"] == "/docs"


def test_readyz_contract_without_database() -> None:
    """Без БД /readyz обязан отвечать 503 по контракту, а не 500."""
    if DB_IS_AVAILABLE:
        pytest.skip("в CI поднята тестовая БД — проверяется отдельным тестом")

    with TestClient(app) as client:
        response = client.get("/readyz")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "unavailable"
    assert body["database"] in {"not_configured", "error"}


@pytest.mark.skipif(not DB_IS_AVAILABLE, reason="нет тестовой БД (GEOPULS_CI_DB != 1)")
def test_readyz_ok_with_database() -> None:
    with TestClient(app) as client:
        response = client.get("/readyz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}
