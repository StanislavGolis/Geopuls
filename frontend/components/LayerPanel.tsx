"use client";

import { Layers } from "lucide-react";
import { useState } from "react";

import type { LayerGrid, LayerMeta, LayerObjectsResponse } from "@/lib/api";
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
  /** Слой, объекты которого подсвечены на карте (`null` — подсветки нет). */
  objectsSlug?: string | null;
  /** Данные подсветки: по ним показываем, сколько объектов попало в границы вида. */
  objectsData?: LayerObjectsResponse | null;
  onToggle: (ref: LayerRef) => void;
  /** Включить подсветку объектов слоя; повторный вызов с тем же слоем снимает её. */
  onToggleObjects: (slug: string) => void;
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
  objectsSlug = null,
  objectsData = null,
  onToggle,
  onToggleObjects,
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
                {/*
                  Подсветка объектов: один слой за раз, поэтому это не второй чекбокс, а переключатель —
                  два контура поверх заливки уже спорят за внимание (план §6).
                */}
                <button
                  type="button"
                  className={`layers__map${objectsSlug === layer.slug ? " layers__map--active" : ""}`}
                  aria-pressed={objectsSlug === layer.slug}
                  data-testid={`layer-map-${layer.slug}`}
                  title="Показать объекты слоя на карте (один слой за раз)"
                  onClick={() => onToggleObjects(layer.slug)}
                >
                  на карте
                </button>
                {isOn && (
                  <span className="layers__note">
                    {metricLabel(layer.metric_kind)}
                    {layer.unit ? `, ${layer.unit}` : ""}
                    {column ? "" : " — данные ещё собираются"}
                  </span>
                )}
                {objectsSlug === layer.slug && objectsData && (
                  <span className="layers__note" data-testid="layer-objects-note">
                    объектов в границах вида: {objectsData.meta.returned}
                    {objectsData.meta.truncated
                      ? ` из ${objectsData.meta.total} — показаны не все, приблизьте карту`
                      : ""}
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