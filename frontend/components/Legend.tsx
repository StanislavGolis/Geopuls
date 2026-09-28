"use client";

import { Info } from "lucide-react";
import { useState } from "react";

import { pluralObjects } from "@/lib/format";
import { legendItems } from "@/lib/heat";

export type LegendProps = {
  /** Границы классов из `meta.density_breaks` (считает бэкенд). */
  breaks: number[] | null | undefined;
  /** Разрешение текущей сетки — показываем в легенде, а не в шапке. */
  res?: number;
  /** Сколько объектов найдено в городе: для счётчика и пометки «мало данных». */
  poiCount?: number;
  /** Порог, ниже которого честно предупреждаем о неполноте данных. */
  thinDataThreshold?: number;
};

export default function Legend({ breaks, res, poiCount, thinDataThreshold = 30 }: LegendProps) {
  const [expanded, setExpanded] = useState(false);
  const items = legendItems(breaks);
  const isThin = typeof poiCount === "number" && poiCount > 0 && poiCount < thinDataThreshold;
  const showCount = typeof poiCount === "number" && poiCount >= 0;

  return (
    <section
      className={`legend legend--${expanded ? "expanded" : "collapsed"}`}
      aria-label="Легенда плотности объектов"
    >
      {/* На мобильном легенда свёрнута в кнопку; на десктопе кнопка скрыта стилями */}
      <button
        type="button"
        className="legend__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Info size={16} aria-hidden="true" />
        <span>Легенда</span>
      </button>

      <div className="legend__body">
        <h2 className="legend__title">Плотность, POI / км²</h2>

        <ul className="legend__list">
          {items.map((item) => (
            <li className="legend__item" key={`${item.color}-${item.label}`}>
              <span
                className={`legend__swatch${item.from === null ? " legend__swatch--empty" : ""}`}
                style={{ background: item.color }}
                aria-hidden="true"
              />
              <span className="legend__value">{item.label}</span>
              {item.note && <span className="legend__note">{item.note}</span>}
            </li>
          ))}
        </ul>

        {isThin && <p className="legend__warning">Мало данных OSM — карта может быть неполной</p>}

        <p className="legend__source">
          Только объекты, размеченные в OpenStreetMap: пустая ячейка не значит, что бизнеса нет.
        </p>

        <p className="legend__meta">
          {typeof res === "number" && (
            <span className="mono" data-testid="resolution">
              res {res}
            </span>
          )}
          {typeof res === "number" && showCount && " · "}
          {showCount && <span>в категории {pluralObjects(poiCount)}</span>}
        </p>
      </div>
    </section>
  );
}
