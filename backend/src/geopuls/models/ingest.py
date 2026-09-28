"""Журнал импортов: дата выгрузки, объёмы, ошибки."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from geopuls.models.base import Base


class ImportRun(Base):
    """Один запуск импорта.

    ``osm_timestamp`` — дата данных OSM из заголовка выгрузки: именно её видит пользователь
    в интерфейсе («данные на …»). Падение импорта не портит текущие данные: запись остаётся
    со статусом ``failed`` и текстом ошибки.
    """

    __tablename__ = "import_runs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    source: Mapped[str] = mapped_column(String(20))
    source_url: Mapped[str | None] = mapped_column(Text)
    osm_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 'running' | 'ok' | 'failed'
    status: Mapped[str] = mapped_column(String(20), server_default=text("'running'"))
    city_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("cities.id", ondelete="SET NULL"))
    pois_upserted: Mapped[int | None] = mapped_column(Integer)
    cells_written: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
