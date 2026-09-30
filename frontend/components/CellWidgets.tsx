"use client";

import { X } from "lucide-react";

import type { LayerGrid, MapLayerColumn } from "@/lib/api";
import { formatLayerValue, metricLabel } from "@/lib/layers";
import { stopPanelClick } from "@/lib/panels";
import { classLabel, densityDistribution, topZones } from "@/lib/widgets";

export type CellWidgetsProps = {
  grid: LayerGrid;
  /** Слой, которым покрашена карта: виджеты отвечают числами того же слоя. */
  column: MapLayerColumn;
  /** Выбранная зона: подсвечиваем строку в списке. */
  selectedCell?: string | null;
  /** Класс плотности, подсвеченный на карте (`null` — не выбран). */
  activeClass?: number | null;
  onZoneSelect: (h3: string) => void;
  onClassSelect: (index: number | null) => void;
  onClose: () => void;
};

/**
 * Виджеты по зонам: «где выбранного больше всего» и «как зоны распределены по плотности».
 *
 * Считаются по уже загруженной сетке, поэтому не могут разойтись с картой. Действия честные: клик по
 * зоне открывает её карточку и подводит карту, клик по классу подсвечивает контуром зоны этого класса —
 * у виджета нет действия, которого не видно на карте (ADR 0016).
 */
export default function CellWidgets({
  grid,
  column,
  selectedCell = null,
  activeClass = null,
  onZoneSelect,
  onClassSelect,
  onClose,
}: CellWidgetsProps) {
  const zones = topZones(grid, column);
  const distribution = densityDistribution(grid, column);
  const maxClass = Math.max(...distribution.classes.map((item) => item.count), 0);

  return (
    <section
      className="widgets"
      aria-label="Сводка по зонам"
      data-testid="cell-widgets"
      // Клик по сводке — это клик по панели, а не по карте (см. stopPanelClick)
      onClick={stopPanelClick}
    >
      <header className="widgets__head">
        <div>
          <h2 className="widgets__title">Зоны</h2>
          <p className="widgets__subtitle">
            {column.name} · {metricLabel(column.metric_kind)}
            {column.unit ? `, ${column.unit}` : ""} · {grid.meta.cell_count} зон
          </p>
        </div>
        <button
          type="button"
          className="widgets__close"
          onClick={onClose}
          aria-label="Скрыть сводку по зонам"
          data-testid="widgets-close"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div className="widgets__block">
        <h3 className="widgets__block-title">Топ зон</h3>
        {zones.length === 0 ? (
          <p className="widgets__note">В этой сетке нет зон со значением больше нуля.</p>
        ) : (
          <ol className="widgets__list" data-testid="widget-zones">
            {zones.map((zone, index) => (
              <li key={zone.h3}>
                <button
                  type="button"
                  className={`widgets__row${zone.h3 === selectedCell ? " widgets__row--active" : ""}`}
                  aria-pressed={zone.h3 === selectedCell}
                  data-testid={`widget-zone-${zone.h3}`}
                  onClick={() => onZoneSelect(zone.h3)}
                >
                  <span className="widgets__rank mono">{index + 1}</span>
                  <span className="widgets__value mono">
                    {formatLayerValue(zone.value, column.unit)}
                  </span>
                  <span className="widgets__cell mono">{zone.h3}</span>
                  {zone.count !== null && (
                    <span className="widgets__objects">{zone.count} объектов</span>
                  )}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="widgets__block">
        <h3 className="widgets__block-title">Классы плотности</h3>
        {distribution.classes.length === 0 ? (
          <p className="widgets__note">Классы появятся, когда в городе появятся данные по этому слою.</p>
        ) : (
          <ul className="widgets__list" data-testid="widget-classes">
            {distribution.classes.map((item, index) => {
              const isLast = index === distribution.classes.length - 1;
              const isActive = item.index === activeClass;

              return (
                <li key={item.index}>
                  <button
                    type="button"
                    className={`widgets__row${isActive ? " widgets__row--active" : ""}`}
                    aria-pressed={isActive}
                    data-testid={`widget-class-${item.index}`}
                    onClick={() => onClassSelect(isActive ? null : item.index)}
                  >
                    <span className="widgets__class-label mono">{classLabel(item, isLast)}</span>
                    <span className="widgets__bar" aria-hidden="true">
                      <span
                        className="widgets__bar-fill"
                        style={{ width: `${maxClass > 0 ? (item.count / maxClass) * 100 : 0}%` }}
                      />
                    </span>
                    <span className="widgets__count mono">{item.count}</span>
                  </button>
                </li>
              );
            })}
            {/* Ноль и «нет данных» — разные состояния, и оба не являются классом плотности */}
            <li className="widgets__row widgets__row--static" data-testid="widget-empty">
              <span className="widgets__class-label mono">0</span>
              <span className="widgets__objects">пусто</span>
              <span className="widgets__count mono">{distribution.empty}</span>
            </li>
            {distribution.unknown > 0 && (
              <li className="widgets__row widgets__row--static" data-testid="widget-unknown">
                <span className="widgets__class-label mono">—</span>
                <span className="widgets__objects">нет данных</span>
                <span className="widgets__count mono">{distribution.unknown}</span>
              </li>
            )}
          </ul>
        )}
      </div>

      <p className="widgets__footer-note">
        Наблюдения по данным OSM: «пусто» — нет размеченных объектов, «нет данных» — слой не покрывает зону
        (ADR 0015). Клик по зоне открывает её карточку, клик по классу подсвечивает зоны контуром.
      </p>
    </section>
  );
}
