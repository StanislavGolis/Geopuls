"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiError, type PoiItem, type PoisMeta, fetchPois } from "@/lib/api";
import { pluralObjects } from "@/lib/format";
import { legendItems } from "@/lib/heat";
import { formatLayerValue, metricLabel } from "@/lib/layers";
import { stopPanelClick } from "@/lib/panels";

/** Значение слоя в выбранной зоне: числа приходят по всем слоям, а не только по включённым. */
export type CellMetricView = {
  slug: string;
  name: string;
  unit: string | null;
  metricKind: string;
  /** `base` — слой красит карту, `overlay` — дополнительный: в сводке это помечено. */
  role: "base" | "overlay";
  /** Значение для этой ячейки; null — у слоя нет данных по ней (это не ноль). */
  value: number | null;
  /** Слой покрывает всю сетку города. Если нет — «нет данных» значит «слой сюда не дошёл». */
  covered: boolean;
};

export type ZonePanelProps = {
  city: string;
  /** H3-индекс выбранной зоны. */
  cell: string;
  res: number;
  /** Категория, объекты которой показываем: та же, что красит карту. */
  category: string | null;
  /** Названия категорий по slug: в интерфейсе показываем русские имена, а не slug'и API. */
  categoryNames: Record<string, string>;
  /** Значения всех слоёв по этой зоне. */
  metrics?: CellMetricView[];
  /** Границы классов базового слоя: по ним называем класс плотности зоны. */
  baseBreaks?: number[] | null;
  onClose: () => void;
};

type Status = "loading" | "ready" | "empty" | "error";

const EMPTY_TEXT =
  "В этой зоне нет размеченных объектов по выбранной категории. Это не значит, что бизнеса нет: " +
  "в OpenStreetMap его мог никто не отметить.";

/**
 * Класс плотности зоны по границам базового слоя: «до 12.4», «12.4 – 30», «более 30» или «пусто».
 *
 * Нужен, чтобы число в сводке читалось так же, как цвет на карте: без класса значение 18.7 ничего не
 * говорит о том, много это или мало.
 */
function densityClassLabel(breaks: number[] | null | undefined, value: number | null): string | null {
  if (value === null) return null;
  const items = legendItems(breaks);
  if (value <= 0) return items[0]?.label ?? null;
  // Берём последний класс, нижняя граница которого не выше значения: классы идут по возрастанию
  const found = items.filter((item) => item.from !== null && value >= item.from).pop();
  return found?.label ?? null;
}


/**
 * Сводка по зоне: всё, что известно про выбранный гекс, в одном окне.
 *
 * Раньше это была карточка «объекты в ячейке»: список организаций плюс числа тех слоёв, которые
 * пользователь заранее включил чекбоксами. Приходилось выбирать, что показывать, до того как посмотреть,
 * — и это было лишним решением. Теперь показываем всё: числа всех слоёв, класс плотности базового слоя и
 * объекты выбранной категории. Молчать о части данных значило бы врать; «нет данных» и «пусто» — разные
 * состояния и подписаны словами (ADR 0015).
 */
export default function ZonePanel({
  city,
  cell,
  res,
  category,
  categoryNames,
  metrics = [],
  baseBreaks = null,
  onClose,
}: ZonePanelProps) {
  const [items, setItems] = useState<PoiItem[]>([]);
  const [meta, setMeta] = useState<PoisMeta | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");

    (async () => {
      try {
        const response = await fetchPois({ city, cell, res, category: category ?? undefined });
        if (cancelled) return;
        setItems(response.items);
        setMeta(response.meta);
        setError(null);
        setStatus(response.items.length > 0 ? "ready" : "empty");
      } catch (exc) {
        if (cancelled) return;
        setError(
          exc instanceof ApiError
            ? exc
            : new ApiError(0, "Непредвиденная ошибка", exc instanceof Error ? exc.message : String(exc)),
        );
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [city, cell, res, category, reloadToken]);

  const retry = useCallback(() => setReloadToken((value) => value + 1), []);

  return (
    <section
      className="zone-panel"
      aria-label="Сводка по выбранной зоне"
      data-testid="zone-panel"
      onClick={stopPanelClick}
    >
      <header className="zone-panel__head">
        <div>
          <span className="zone-panel__title">Сводка по зоне</span>
          <span className="zone-panel__count" data-testid="zone-count">
            {status === "ready" && meta ? pluralObjects(meta.total) : ""}
          </span>
        </div>
        <button
          type="button"
          className="zone-panel__close"
          onClick={onClose}
          aria-label="Закрыть сводку по зоне"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <p className="zone-panel__cell mono" title="Ячейка сетки Uber H3">
        {cell}
        <span className="zone-panel__res">res {res}</span>
      </p>


      {/* Числа всех слоёв: «что здесь ещё есть» рядом с ответом про конкуренцию, а не отдельной картой */}
      {metrics.length > 0 && (
        <dl className="zone-panel__metrics" data-testid="cell-metrics">
          {metrics.map((metric) => {
            const isBase = metric.role === "base";
            const label = densityClassLabel(baseBreaks, isBase ? metric.value : null);

            return (
              <div
                className={`zone-panel__metric${isBase ? " zone-panel__metric--base" : ""}`}
                key={metric.slug}
                data-testid={`zone-metric-${metric.slug}`}
              >
                <dt className="zone-panel__metric-name">
                  {metric.name}
                  {isBase && <span className="zone-panel__badge">основа карты</span>}
                </dt>
                <dd className="zone-panel__metric-value">
                  {formatLayerValue(metric.value, metric.unit)}
                  <span className="zone-panel__metric-kind">{metricLabel(metric.metricKind)}</span>
                  {/* Класс подписываем словами: «18.7» само по себе не говорит, много это или мало */}
                  {label && <span className="zone-panel__metric-class">{label}</span>}
                  {metric.value === null && (
                    <span className="zone-panel__metric-note">
                      {metric.covered
                        ? "нет данных по этой зоне"
                        : "слой покрывает город не полностью — данных по зоне нет"}
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}

      <h3 className="zone-panel__section">
        Организации выбранной категории
        <span className="zone-panel__section-note">
          {category ? (categoryNames[category] ?? category) : "без фильтра по категории"}
        </span>
      </h3>

      {status === "loading" && <p className="zone-panel__note">Загружаем объекты…</p>}

      {status === "empty" && (
        <p className="zone-panel__note" data-testid="zone-empty">
          {EMPTY_TEXT}
        </p>
      )}

      {status === "error" && error && (
        <div className="zone-panel__error" data-testid="zone-error">
          <strong>{error.title}</strong>
          <p>{error.detail}</p>
          {error.isOffline && <p>Проверьте соединение с интернетом и попробуйте снова.</p>}
          <button type="button" className="overlay__button" onClick={retry}>
            Повторить
          </button>
        </div>
      )}

      {status === "ready" && (
        <ul className="zone-panel__list">
          {items.map((poi) => (
            <li className="zone-panel__item" key={`${poi.osm_type}-${poi.osm_id}`}>
              <div className="zone-panel__name">{poi.name ?? poi.brand ?? "Без названия"}</div>
              {poi.name && poi.brand && poi.brand !== poi.name && (
                <div className="zone-panel__brand">{poi.brand}</div>
              )}
              {poi.address && <div className="zone-panel__address">{poi.address}</div>}
              <div className="zone-panel__foot">
                <span className="zone-panel__tags">
                  {poi.categories.map((slug) => categoryNames[slug] ?? slug).join(" · ")}
                </span>
                <a className="zone-panel__link" href={poi.osm_url} target="_blank" rel="noreferrer">
                  OpenStreetMap
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}

      {status === "ready" && meta && meta.returned < meta.total && (
        <p className="zone-panel__note">
          Показано {meta.returned} из {meta.total} — список ограничен размером ответа.
        </p>
      )}

      <p className="zone-panel__footer-note">
        Числа слоёв — из той же сетки, что нарисована на карте: «нет данных» значит «слой не покрывает
        зону», «пусто» — «объектов нет» (ADR 0015).
      </p>
    </section>
  );
}
