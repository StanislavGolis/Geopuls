"use client";

import { Layers } from "lucide-react";
import { useState } from "react";

import type { LayerMeta, LayerObjectsResponse } from "@/lib/api";
import { stopPanelClick } from "@/lib/panels";

export type LayerPanelProps = {
  /** Реестр слоёв из API: панель строится из него, а не из списка в коде. */
  layers: LayerMeta[];
  /** Основа карты — слой конкурентов: он не отключается, это главный ответ приложения. */
  base: LayerMeta | null;
  /** Слои, объекты которых подсвечены на карте. Включено может быть сколько угодно. */
  objectsSlugs?: string[];
  /** Данные подсветки по слоям: из них берём, сколько объектов попало в границы вида. */
  objectsData?: Record<string, LayerObjectsResponse | null>;
  /** Переключить слой: включить или выключить его объекты на карте. */
  onToggleObjects: (slug: string) => void;
};

/**
 * Панель слоёв: какие объекты показать на карте.
 *
 * Чего здесь нет и почему:
 * - **основы карты.** Она очевидна и видна дважды: в панели сцены (категория конкурентов или показатель
 *   слоя) и в легенде на карте. Вкладка «Конкуренты» всегда красит карту организациями выбранной
 *   категории, вкладка «Инфраструктура» — объектами выбранного слоя; отдельный блок об этом только
 *   занимал место и повторял уже сказанное.
 * - **чекбоксов «числа в ячейке».** Числа всех слоёв показывает сводка по зоне (`ZonePanel`): заранее
 *   выбирать, что показать, не нужно — умолчать о части данных значило бы соврать.
 * - **переключателя основы**: смена основы меняла бы главный ответ приложения.
 *
 * Остались тумблеры: один слой — один тумблер, включить можно сколько угодно. Это честнее кнопки
 * «на карте», которая была одна и вела себя как радио: тумблер видно как выбор, а не как единственную
 * доступную кнопку.
 */
export default function LayerPanel({
  layers,
  base,
  objectsSlugs = [],
  objectsData = {},
  onToggleObjects,
}: LayerPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const extraLayers = layers.filter((layer) => layer.slug !== base?.slug);

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
          <legend className="layers__title">Объекты на карте</legend>
          <p className="layers__note">
            Числа всех слоёв — в сводке по зоне; тумблер показывает объекты слоя на карте.
          </p>

          {extraLayers.map((layer) => {
            const isOn = objectsSlugs.includes(layer.slug);
            const data = objectsData[layer.slug] ?? null;

            return (
              <div className="layers__row" key={layer.slug}>
                <label className="layers__option">
                  <input
                    type="checkbox"
                    role="switch"
                    className="layers__switch"
                    checked={isOn}
                    data-testid={`layer-objects-${layer.slug}`}
                    onChange={() => onToggleObjects(layer.slug)}
                  />
                  <span className="layers__swatch" style={{ background: layer.color }} aria-hidden="true" />
                  <span>{layer.name}</span>
                </label>
                {isOn && (
                  <span className="layers__note" data-testid={`layer-objects-note-${layer.slug}`}>
                    {data
                      ? `объектов в границах вида: ${data.meta.returned}${
                          data.meta.truncated
                            ? ` из ${data.meta.total} — показаны не все, приблизьте карту`
                            : ""
                        }`
                      : "загружаем объекты…"}
                  </span>
                )}
              </div>
            );
          })}
        </fieldset>

        <div className="layers__sources" data-testid="layer-sources">
          {/* Атрибуция слоёв — одна строка на всех: построчно она дублировала общую строку под картой */}
          <p className="layers__source">
            <span className="layers__attribution">Данные слоёв: © OpenStreetMap contributors (ODbL)</span>
          </p>
        </div>
      </div>
    </section>
  );
}
