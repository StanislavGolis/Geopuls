"use client";

import { Info } from "lucide-react";
import { useState } from "react";

import { pluralObjects } from "@/lib/format";
import { legendItems } from "@/lib/heat";
import { metricLabel, type LayerLegend } from "@/lib/layers";

/** Наложение в легенде: цвет контура на карте должен быть объяснён, вместе с охватом. */
export type LegendOverlay = {
  slug: string;
  name: string;
  color: string;
  /** Сколько ячеек закрашено контуром: «есть на карте» без числа — не информация. */
  nonEmptyCount: number;
};

export type LegendProps = {
  /** Базовый слой: его значениями раскрашена карта (null — данные ещё не приехали). */
  layer: LayerLegend | null;
  /** Наложения: показываем цвет контура и охват, иначе контуры на карте не с чем соотнести. */
  overlays?: LegendOverlay[];
  /** Разрешение текущей сетки — показываем в легенде, а не в шапке. */
  res?: number;
  /** Порог, ниже которого честно предупреждаем о неполноте данных. */
  thinDataThreshold?: number;
  /** Базовый слой собран не по всей сетке: это нужно сказать прямо. */
  partialCoverage?: boolean;
};

export default function Legend({
  layer,
  overlays = [],
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

        {overlays.length > 0 && (
          <div className="legend__overlays" data-testid="legend-overlays">
            <h3 className="legend__subtitle">Наложения (контур)</h3>
            <ul className="legend__list">
              {overlays.map((overlay) => (
                <li className="legend__item" key={overlay.slug}>
                  <span
                    className="legend__swatch legend__swatch--outline"
                    style={{ borderColor: overlay.color }}
                    aria-hidden="true"
                  />
                  <span>{overlay.name}</span>
                  <span className="legend__note">{pluralObjects(overlay.nonEmptyCount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

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
