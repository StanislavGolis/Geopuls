"use client";

import { legendItems } from "@/lib/heat";

export type LegendProps = {
  /** Границы классов из `meta.density_breaks` (считает бэкенд). */
  breaks: number[] | null | undefined;
  /** Сколько объектов найдено в городе: для пометки «мало данных». */
  poiCount?: number;
  /** Порог, ниже которого честно предупреждаем о неполноте данных. */
  thinDataThreshold?: number;
};

export const POI_UNITS = "POI / км²";

export default function Legend({ breaks, poiCount, thinDataThreshold = 30 }: LegendProps) {
  const items = legendItems(breaks);
  const isThin = typeof poiCount === "number" && poiCount > 0 && poiCount < thinDataThreshold;

  return (
    <div className="legend" role="group" aria-label="Легенда плотности объектов">
      <div className="legend__title">Плотность объектов, {POI_UNITS}</div>
      <ul className="legend__list">
        {items.map((item) => (
          <li className="legend__item" key={`${item.color}-${item.label}`}>
            <span className="legend__swatch" style={{ background: item.color }} aria-hidden="true" />
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
      {isThin && (
        <div className="legend__warning">
          Мало объектов в OSM по этой категории — карта может выглядеть пустой не из-за отсутствия
          бизнеса, а из-за неполноты данных.
        </div>
      )}
      <div className="legend__note">
        Только объекты, размеченные в OpenStreetMap. Полнота зависит от сообщества и не равна реальному
        числу организаций.
      </div>
    </div>
  );
}
