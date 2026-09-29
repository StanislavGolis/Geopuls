"use client";

import { Info } from "lucide-react";
import { useState } from "react";

import { pluralObjects } from "@/lib/format";
import { legendItems } from "@/lib/heat";
import { metricLabel, type LayerLegend } from "@/lib/layers";

export type LegendProps = {
  /** Базовый слой: его значениями раскрашена карта (null — данные ещё не приехали). */
  layer: LayerLegend | null;
  /** Разрешение текущей сетки — показываем в легенде, а не в шапке. */
  res?: number;
  /** Порог, ниже которого честно предупреждаем о неполноте данных. */
  thinDataThreshold?: number;
  /** Базовый слой собран не по всей сетке: это нужно сказать прямо. */
  partialCoverage?: boolean;
};

/** Легенда отвечает только за заливку карты: дополнительные слои дают числа в карточке ячейки. */
export default function Legend({
  layer,
  res,
  thinDataThreshold = 30,
  partialCoverage = false,
}: LegendProps) {
  const [expanded, setExpanded] = useState(false);
  const items = legendItems(layer?.breaks ?? null);
  const objectCount = layer?.objectCount ?? null;
  const isThin = objectCount !== null && objectCount > 0 && objectCount < thinDataThreshold;
  const title = layer
    ? `${metricLabel(layer.metricKind)}${layer.unit ? `, ${layer.unit}` : ""}`
    : "Легенда";

  return (
    <section
      className={`legend legend--${expanded ? "expanded" : "collapsed"}`}
      aria-label="Легенда карты"
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
        <h2 className="legend__title">{title}</h2>
        {layer && <p className="legend__layer-name">{layer.name}</p>}

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
        {partialCoverage && (
          <p className="legend__warning">
            Слой собран не по всей сетке: «нет данных» — это не ноль
          </p>
        )}

        <p className="legend__source">
          Только объекты, размеченные в OpenStreetMap: пустая ячейка не значит, что бизнеса нет.
        </p>

        <p className="legend__meta">
          {typeof res === "number" && (
            <span className="mono" data-testid="resolution">
              res {res}
            </span>
          )}
          {typeof res === "number" && objectCount !== null && " · "}
          {objectCount !== null && <span>в слое {pluralObjects(objectCount)}</span>}
        </p>
      </div>
    </section>
  );
}
