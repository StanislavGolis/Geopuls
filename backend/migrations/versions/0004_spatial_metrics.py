"""Метрики площади и длины: геометрия объектов и границы ячеек (Этап 9).

Зачем: слои «жильё», «работа» и «парковки» измеряются долей площади ячейки, а «пешеходные пути» —
километрами. По одной точке этого не посчитать, поэтому:

- ``pois.geometry`` — геометрия way (линия или полигон). Точка (``location``) остаётся основой всего
  остального: привязки к ячейке, списка объектов и фильтра по полигону города;
- ``city_cells.boundary`` — полигон ячейки, чтобы площадь и длину считал PostGIS пересечением геометрий.
  Иначе большой жилой квартал «сваливался» бы в одну ячейку по центроиду, а соседние выглядели пустыми.

Обе колонки nullable: узлы OSM геометрии не имеют, а сетка городов, собранная до Этапа 9, заполняется
при следующей агрегации.

Revision ID: 0004
Revises: 0003
"""

from __future__ import annotations

import geoalchemy2
import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "pois",
        sa.Column(
            "geometry",
            geoalchemy2.types.Geography(geometry_type="GEOMETRY", srid=4326, spatial_index=False),
            nullable=True,
        ),
    )
    op.create_index("ix_pois_geometry", "pois", ["geometry"], postgresql_using="gist")

    op.add_column(
        "city_cells",
        sa.Column(
            "boundary",
            geoalchemy2.types.Geography(geometry_type="POLYGON", srid=4326, spatial_index=False),
            nullable=True,
        ),
    )
    op.create_index("ix_city_cells_boundary", "city_cells", ["boundary"], postgresql_using="gist")


def downgrade() -> None:
    op.drop_index("ix_city_cells_boundary", table_name="city_cells")
    op.drop_column("city_cells", "boundary")
    op.drop_index("ix_pois_geometry", table_name="pois")
    op.drop_column("pois", "geometry")
