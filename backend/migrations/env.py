"""Окружение Alembic для ГЕОПУЛЬС.

Особенности:
- подключение асинхронное (`asyncpg`), как и у приложения: URL берётся из ``GEOPULS_DATABASE_URL``;
- ``compare_type`` и ``compare_server_default`` включены, чтобы миграции ловили изменения типов;
- ``target_metadata`` — модели из ``geopuls.models`` (там импортируются все таблицы).
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from geopuls.config import get_settings
from geopuls.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Единый источник настроек: то же значение, что использует приложение
database_url = get_settings().database_url
# Экранируем %, если он встретится в пароле
config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))

target_metadata = Base.metadata

# Alembic управляет только нашими таблицами. Всё остальное в БД (таблицы расширений
# postgis_tiger_geocoder, spatial_ref_sys и прочие) игнорируется — иначе автогенерация
# предлагает их удалить, что сломало бы расширения.
MANAGED_TABLES: frozenset[str] = frozenset(Base.metadata.tables) | {"alembic_version"}


def include_object(obj: object, name: str | None, type_: str, reflected: bool, compare_to: object) -> bool:
    """Фильтр объектов для автогенерации: только таблицы из наших моделей."""
    if type_ == "table":
        return name in MANAGED_TABLES
    # Индексы и constraints чужих таблиц (расширений) тоже пропускаем
    table = getattr(obj, "table", None)
    return table is None or table.name in MANAGED_TABLES


def _configure(connection: Connection | None = None, *, url: str | None = None) -> None:
    context.configure(
        connection=connection,
        url=url,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
        include_object=include_object,
        literal_binds=connection is None,
        dialect_opts={"paramstyle": "named"},
    )


def run_migrations_offline() -> None:
    """Генерация SQL без подключения к БД (`alembic upgrade head --sql`)."""
    _configure(url=config.get_main_option("sqlalchemy.url"))
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    _configure(connection=connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
