"use client";

import { Layers } from "lucide-react";
import { useState } from "react";

import type { LayerGrid, LayerMeta } from "@/lib/api";
import { isPartiallyCovered, metricLabel, serializeLayerRef, type LayerRef } from "@/lib/layers";
import { stopPanelClick } from "@/lib/panels";

export type LayerPanelProps = {
  /** Реестр слоёв из API: панель строится из него, а не из списка в коде. */
  layers: LayerMeta[];
  /** Основа карты — слой конкурентов: он не отключается, это главный ответ приложения. */
  base: LayerMeta | null;
  /** Включённые дополнительные слои: их числа показываются в карточке выбранной ячейки. */
  active: LayerRef[];
  /** Данные карты: из них берутся числа и предупреждения о покрытии. */
  grid: LayerGrid | null;
  /** Название выбранной категории — подпись основы карты. */
  categoryName: string | null;
  onToggle: (ref: LayerRef) => void;
};

/**
 * Панель слоёв: основа карты плюс набор дополнительных показателей.
 *
 * Почему без переключателя базового слоя: карта отвечает на один вопрос — где выбранная категория
 * есть, а где её нет, и этот ответ не должен зависеть от того, что пользователь случайно переключил
 * основу. Дополнительные слои не рисуются на карте (пять заливок друг поверх друга нечитаемы), они
 * дают числа в карточке ячейки — по выбранному гексу.
 */
export default function LayerPanel({
  layers,
  base,
  active,
  grid,
  categoryName,
  onToggle,
}: LayerPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const extraLayers = layers.filter((layer) => layer.slug !== base?.slug);
  const columns = new Map((grid?.layers ?? []).map((column) => [column.slug, column]));
  const cellCount = grid?.meta.cell_count ?? 0;

  return (
    <section
      className={`layers layers--${expanded ? "expanded" : "collapsed"}`}
      aria-label="Слои карты"
      onClick={stopPanelClick}
    >
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
        <div className="layers__base" data-testid="layer-base">
          <span className="layers__title">Основа карты</span>
          <span className="layers__base-name">
            {base ? base.name : "—"}
            {categoryName ? ` · ${categoryName}` : ""}
          </span>
          <span className="layers__note">
            Плотность объектов по категории — главный ответ сервиса, слой всегда включён.
          </span>
        </div>

        <fieldset className="layers__group">
          <legend className="layers__title">Дополнительно в ячейке</legend>
          {extraLayers.map((layer) => {
            const isOn = active.some((ref) => ref.slug === layer.slug);
            const column = columns.get(layer.slug);

            return (
              <div className="layers__row" key={layer.slug}>
                <label className="layers__option">
                  <input
                    type="checkbox"
                    checked={isOn}
                    data-testid={`layer-${layer.slug}`}
                    onChange={() =>
                      onToggle({ slug: layer.slug, category: layer.categories[0] ?? null })
                    }
                  />
                  <span>{layer.name}</span>
                </label>
                {isOn && (
                  <span className="layers__note">
                    {metricLabel(layer.metric_kind)}
                    {layer.unit ? `, ${layer.unit}` : ""}
                    {column ? "" : " — данные ещё собираются"}
                  </span>
                )}
              </div>
            );
          })}
          <span className="layers__note">Значения появятся в карточке выбранной ячейки.</span>
        </fieldset>

        <div className="layers__sources" data-testid="layer-sources">
          {active.map((ref) => {
            const meta = layers.find((item) => item.slug === ref.slug);
            const column = columns.get(ref.slug);
            if (!meta) return null;

            return (
              <p className="layers__source" key={serializeLayerRef(ref)}>
                <span className="layers__source-name">{meta.name}</span>
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