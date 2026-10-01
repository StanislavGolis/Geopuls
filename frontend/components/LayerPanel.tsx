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
  /** Слой, объекты которого подсвечены на карте (`null` — подсветки нет). */
  objectsSlug?: string | null;
  /** Данные подсветки: по ним показываем, сколько объектов попало в границы вида. */
  objectsData?: LayerObjectsResponse | null;
  onToggle: (ref: LayerRef) => void;
  /** Включить подсветку объектов слоя; повторный вызов с тем же слоем снимает её. */
  onToggleObjects: (slug: string) => void;
};

/**
 * Панель слоёв: что показать рядом с основой карты.
 *
 * Чего здесь нет и почему:
 * - **основы карты.** Она очевидна и видна дважды: в панели сцены (категория конкурентов или показатель
 *   слоя) и в легенде на карте. Вкладка «Конкуренты» всегда красит карту организациями выбранной
 *   категории, вкладка «Инфраструктура» — объектами выбранного слоя; отдельный блок об этом только
 *   занимал место и повторял уже сказанное.
 * - **переключателя основы**: смена основы меняла бы главный ответ приложения.
 *
 * Что осталось: выбор дополнительных слоёв. У каждого слоя два независимых действия — «числа в карточке
 * зоны» (чекбокс) и «объекты на карте» (переключатель, один слой за раз: пять контуров поверх заливки
 * нечитаемы, план §6).
 */
export default function LayerPanel({
  layers,
  base,
  active,
  grid,
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
        <fieldset className="layers__group">
          <legend className="layers__title">Слои</legend>
          <p className="layers__note">
            Числа слоя — в карточке зоны. «На карте» — объекты слоя, по одному.
          </p>

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
        </fieldset>

        <div className="layers__sources" data-testid="layer-sources">
          {active.map((ref) => {
            const meta = layers.find((item) => item.slug === ref.slug);
            const column = columns.get(ref.slug);
            // Предупреждение о покрытии: «нет данных» — это не ноль, и об этом нужно сказать рядом
            if (!meta || !column || !isPartiallyCovered(column, cellCount)) return null;

            return (
              <p className="layers__source" key={serializeLayerRef(ref)}>
                <span className="layers__source-name">{meta.name}</span>
                <span className="layers__warning">
                  собрано по {column.covered_count} из {cellCount} ячеек
                </span>
              </p>
            );
          })}
          {/* Атрибуция слоёв — одна строка на всех: построчно она дублировала общую строку под картой */}
          <p className="layers__source">
            <span className="layers__attribution">Данные слоёв: © OpenStreetMap contributors (ODbL)</span>
          </p>
        </div>
      </div>
    </section>
  );
}
