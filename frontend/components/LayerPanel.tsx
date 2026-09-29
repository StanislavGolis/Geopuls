"use client";

import { Layers } from "lucide-react";
import { useState } from "react";

import type { LayerGrid, LayerMeta } from "@/lib/api";
import { MAX_OVERLAYS, isPartiallyCovered, metricLabel, serializeLayerRef, type LayerRef } from "@/lib/layers";

export type LayerPanelProps = {
  /** Реестр слоёв из API: панель строится из него, а не из списка в коде. */
  layers: LayerMeta[];
  /** Базовый слой — тот, что красит карту (ADR 0013). */
  base: LayerRef | null;
  /** Наложения: не больше двух. */
  overlays: LayerRef[];
  /** Данные карты: из них берутся числа и предупреждения о покрытии. */
  grid: LayerGrid | null;
  /** Названия категорий — для подписей вариантов слоя. */
  categoryNames: Record<string, string>;
  onSelectBase: (ref: LayerRef) => void;
  onToggleOverlay: (ref: LayerRef) => void;
};

/** Подпись слоя с вариантом: «Конкуренты (объекты по категориям) · Кофейни». */
function layerLabel(layer: LayerMeta, category: string | null, names: Record<string, string>): string {
  if (!category) return layer.name;
  return `${layer.name} · ${names[category] ?? category}`;
}

export default function LayerPanel({
  layers,
  base,
  overlays,
  grid,
  categoryNames,
  onSelectBase,
  onToggleOverlay,
}: LayerPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const baseLayers = layers.filter((layer) => layer.can_be_base);
  const limitReached = overlays.length >= MAX_OVERLAYS;
  const columns = new Map((grid?.layers ?? []).map((column) => [column.slug, column]));
  const cellCount = grid?.meta.cell_count ?? 0;
  const active: LayerRef[] = [...(base ? [base] : []), ...overlays];

  return (
    <section className={`layers layers--${expanded ? "expanded" : "collapsed"}`} aria-label="Слои карты">
      {/* На мобильном панель свёрнута в кнопку; на десктопе кнопка скрыта стилями */}
      <button
        type="button"
        className="layers__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Layers size={16} aria-hidden="true" />
        <span>Слои</span>
      </button>

      <div className="layers__body">
        <fieldset className="layers__group">
          <legend className="layers__title">Базовый слой (красит карту)</legend>
          {baseLayers.map((layer) => {
            const selected = base?.slug === layer.slug;
            return (
              <div className="layers__row" key={layer.slug}>
                <label className="layers__option">
                  <input
                    type="radio"
                    name="layer-base"
                    value={layer.slug}
                    checked={selected}
                    data-testid={`base-${layer.slug}`}
                    onChange={() =>
                      onSelectBase({ slug: layer.slug, category: layer.categories[0] ?? null })
                    }
                  />
                  <span>{layer.name}</span>
                </label>
                {selected && layer.categories.length > 0 && (
                  <select
                    className="layers__variant"
                    aria-label={`Категория слоя ${layer.name}`}
                    data-testid={`base-category-${layer.slug}`}
                    value={base?.category ?? ""}
                    onChange={(event) => onSelectBase({ slug: layer.slug, category: event.target.value })}
                  >
                    {layer.categories.map((category) => (
                      <option key={category} value={category}>
                        {categoryNames[category] ?? category}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </fieldset>

        <fieldset className="layers__group">
          <legend className="layers__title">Наложения (до {MAX_OVERLAYS}, контуром)</legend>
          {layers.map((layer) => {
            const current = overlays.find((ref) => ref.slug === layer.slug) ?? null;
            const isBase = base?.slug === layer.slug;
            const next: LayerRef = current ?? {
              slug: layer.slug,
              category: layer.categories[0] ?? null,
            };
            const blocked = isBase || (!current && limitReached);

            return (
              <div className="layers__row" key={`overlay-${layer.slug}`}>
                <label className="layers__option">
                  <input
                    type="checkbox"
                    checked={current !== null}
                    disabled={blocked}
                    data-testid={`overlay-${layer.slug}`}
                    onChange={() => onToggleOverlay(next)}
                  />
                  <span>{layer.name}</span>
                </label>
                {current && layer.categories.length > 0 && (
                  <select
                    className="layers__variant"
                    aria-label={`Категория наложения ${layer.name}`}
                    data-testid={`overlay-category-${layer.slug}`}
                    value={current.category ?? ""}
                    onChange={(event) =>
                      onToggleOverlay({ slug: layer.slug, category: event.target.value })
                    }
                  >
                    {layer.categories.map((category) => (
                      <option key={category} value={category}>
                        {categoryNames[category] ?? category}
                      </option>
                    ))}
                  </select>
                )}
                {isBase && <span className="layers__note">уже красит карту</span>}
                {!isBase && !current && limitReached && (
                  <span className="layers__note">сначала снимите другое наложение</span>
                )}
              </div>
            );
          })}
        </fieldset>

        <div className="layers__sources" data-testid="layer-sources">
          {active.map((ref) => {
            const meta = layers.find((layer) => layer.slug === ref.slug);
            const column = columns.get(ref.slug);
            if (!meta) return null;

            return (
              <p className="layers__source" key={serializeLayerRef(ref)}>
                <span className="layers__source-name">
                  {layerLabel(meta, ref.category, categoryNames)}
                </span>
                {column && (
                  <span className="layers__source-meta">
                    {metricLabel(column.metric_kind)}
                    {column.unit ? `, ${column.unit}` : ""}
                  </span>
                )}
                {column && isPartiallyCovered(column, cellCount) && (
                  <span className="layers__warning">
                    собрано по {column.covered_count} из {cellCount} ячеек
                  </span>
                )}
                {meta.source?.attribution_text && (
                  <span className="layers__attribution">{meta.source.attribution_text}</span>
                )}
              </p>
            );
          })}
        </div>
      </div>
    </section>
  );
}