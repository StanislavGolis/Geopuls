"""Слои, источники данных и метрики по ячейкам (ADR 0013)

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-29

Схема: ``datasets`` (источник + лицензия + версия), ``layers`` (слой как продуктовая единица),
``cell_metrics`` (значение метрики по ячейке с версией данных в ключе) и ``categories.layer_id``
(категория — вариант внутри слоя).

Данные: заводим источник OSM и слой «Конкуренты» (сегодняшние восемь категорий), затем переносим
``cell_stats`` в ``cell_metrics``: ``density`` становится значением слоя, число объектов и доля
адресов — дополнительными показателями в ``extras``. Таблица ``cell_stats`` пока остаётся: на время
Этапа 8 агрегатор пишет в обе таблицы, а чтение переключается отдельным шагом.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "datasets",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("slug", sa.String(length=50), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("license", sa.String(length=100), nullable=True),
        sa.Column("license_url", sa.Text(), nullable=True),
        sa.Column("attribution_text", sa.Text(), nullable=True),
        sa.Column("citation", sa.Text(), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("data_version", sa.String(length=50), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_datasets")),
        sa.UniqueConstraint("slug", name=op.f("uq_datasets_slug")),
    )
    op.create_table(
        "layers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("slug", sa.String(length=50), nullable=False),
        sa.Column("name_ru", sa.String(length=200), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("metric_kind", sa.String(length=20), nullable=False),
        sa.Column("unit", sa.String(length=50), nullable=True),
        sa.Column("scale", sa.String(length=20), server_default=sa.text("'quantile'"), nullable=False),
        sa.Column("color", sa.String(length=20), server_default=sa.text("'#1f6fb2'"), nullable=False),
        sa.Column("can_be_base", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("dataset_id", sa.Integer(), nullable=True),
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["dataset_id"], ["datasets.id"], name=op.f("fk_layers_dataset_id_datasets"), ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_layers")),
        sa.UniqueConstraint("slug", name=op.f("uq_layers_slug")),
    )
    op.create_table(
        "cell_metrics",
        sa.Column("city_id", sa.Integer(), nullable=False),
        sa.Column("layer_id", sa.Integer(), nullable=False),
        sa.Column(
            "category_key",
            sa.Integer(),
            sa.Computed("coalesce(category_id, 0)", persisted=True),
            nullable=False,
        ),
        sa.Column("resolution", sa.SmallInteger(), nullable=False),
        sa.Column("h3_index", sa.BigInteger(), nullable=False),
        sa.Column("data_version", sa.String(length=50), nullable=False),
        sa.Column("category_id", sa.Integer(), nullable=True),
        sa.Column("value", sa.Float(), server_default=sa.text("0"), nullable=False),
        sa.Column("value_kind", sa.String(length=20), nullable=False),
        sa.Column("extras", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("dataset_id", sa.Integer(), nullable=True),
        sa.Column("computed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["category_id"], ["categories.id"], name=op.f("fk_cell_metrics_category_id_categories"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["city_id"], ["cities.id"], name=op.f("fk_cell_metrics_city_id_cities"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["dataset_id"], ["datasets.id"], name=op.f("fk_cell_metrics_dataset_id_datasets"), ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["layer_id"], ["layers.id"], name=op.f("fk_cell_metrics_layer_id_layers"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint(
            "city_id",
            "layer_id",
            "category_key",
            "resolution",
            "h3_index",
            "data_version",
            name=op.f("pk_cell_metrics"),
        ),
    )
    op.create_index("ix_cell_metrics_city_layer_res", "cell_metrics", ["city_id", "layer_id", "resolution"])
    op.create_index("ix_cell_metrics_h3", "cell_metrics", ["h3_index"])
    op.add_column("categories", sa.Column("layer_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        op.f("fk_categories_layer_id_layers"), "categories", "layers", ["layer_id"], ["id"], ondelete="SET NULL"
    )

    # --- данные: источник, слой «Конкуренты» и перенос cell_stats ----------
    op.execute(
        """
        INSERT INTO datasets (slug, title, license, license_url, attribution_text, source_url, data_version)
        SELECT 'osm', 'OpenStreetMap (Geofabrik)', 'ODbL 1.0',
               'https://opendatacommons.org/licenses/odbl/1-0/',
               '© OpenStreetMap contributors',
               'https://download.geofabrik.de/russia/siberian-fed-district-latest.osm.pbf',
               (SELECT max(version) FROM data_versions)
        WHERE NOT EXISTS (SELECT 1 FROM datasets WHERE slug = 'osm')
        """
    )
    op.execute(
        """
        INSERT INTO layers (slug, name_ru, kind, metric_kind, unit, scale, color, can_be_base, dataset_id, sort_order)
        SELECT 'competitors', 'Конкуренты (объекты по категориям)', 'osm', 'density', 'POI/км²',
               'quantile', '#1f6fb2', true, (SELECT id FROM datasets WHERE slug = 'osm'), 10
        WHERE NOT EXISTS (SELECT 1 FROM layers WHERE slug = 'competitors')
        """
    )
    op.execute(
        """
        UPDATE categories SET layer_id = (SELECT id FROM layers WHERE slug = 'competitors')
        WHERE layer_id IS NULL
        """
    )
    op.execute(
        """
        INSERT INTO cell_metrics (city_id, layer_id, category_id, resolution, h3_index, data_version,
                                  value, value_kind, extras, dataset_id, computed_at)
        SELECT cs.city_id,
               (SELECT id FROM layers WHERE slug = 'competitors'),
               cs.category_id, cs.resolution, cs.h3_index,
               coalesce((SELECT max(version) FROM data_versions), 'unknown'),
               cs.density, 'density',
               jsonb_strip_nulls(jsonb_build_object(
                   'count', cs.poi_count,
                   'has_address_ratio', cs.has_address_ratio
               )),
               (SELECT id FROM datasets WHERE slug = 'osm'),
               now()
        FROM cell_stats cs
        ON CONFLICT DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_constraint(op.f("fk_categories_layer_id_layers"), "categories", type_="foreignkey")
    op.drop_column("categories", "layer_id")
    op.drop_index("ix_cell_metrics_h3", table_name="cell_metrics")
    op.drop_index("ix_cell_metrics_city_layer_res", table_name="cell_metrics")
    op.drop_table("cell_metrics")
    op.drop_table("layers")
    op.drop_table("datasets")
