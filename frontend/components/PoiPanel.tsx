"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiError, type PoiItem, type PoisMeta, fetchPois } from "@/lib/api";
import { pluralObjects } from "@/lib/format";

export type PoiPanelProps = {
  city: string;
  /** Фильтр по категории: показываем те же объекты, что и в тепловом слое. */
  category: string | null;
  /** H3-индекс выбранной ячейки. */
  cell: string;
  res: number;
  /** Названия категорий по slug: в интерфейсе показываем русские имена, а не slug'и API. */
  categoryNames: Record<string, string>;
  onClose: () => void;
};

type Status = "loading" | "ready" | "empty" | "error";

const EMPTY_TEXT =
  "В этой ячейке нет размеченных объектов по выбранной категории. Это не значит, что бизнеса нет: " +
  "в OpenStreetMap его мог никто не отметить.";

export default function PoiPanel({
  city,
  category,
  cell,
  res,
  categoryNames,
  onClose,
}: PoiPanelProps) {
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
    <section className="poi-panel" aria-label="Объекты в выбранной ячейке" data-testid="poi-panel">
      <header className="poi-panel__head">
        <span className="poi-panel__title">Объекты в ячейке</span>
        <span className="poi-panel__count" data-testid="poi-count">
          {status === "ready" && meta ? pluralObjects(meta.total) : ""}
        </span>
        <button
          type="button"
          className="poi-panel__close"
          onClick={onClose}
          aria-label="Закрыть список объектов"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <p className="poi-panel__cell mono" title="Ячейка сетки Uber H3">
        {cell}
      </p>

      {status === "loading" && <p className="poi-panel__note">Загружаем объекты…</p>}

      {status === "empty" && (
        <p className="poi-panel__note" data-testid="poi-empty">
          {EMPTY_TEXT}
        </p>
      )}

      {status === "error" && error && (
        <div className="poi-panel__error" data-testid="poi-error">
          <strong>{error.title}</strong>
          <p>{error.detail}</p>
          {error.isOffline && <p>Проверьте соединение с интернетом и попробуйте снова.</p>}
          <button type="button" className="overlay__button" onClick={retry}>
            Повторить
          </button>
        </div>
      )}

      {status === "ready" && (
        <ul className="poi-panel__list">
          {items.map((poi) => (
            <li className="poi-panel__item" key={`${poi.osm_type}-${poi.osm_id}`}>
              <div className="poi-panel__name">{poi.name ?? poi.brand ?? "Без названия"}</div>
              {poi.name && poi.brand && poi.brand !== poi.name && (
                <div className="poi-panel__brand">{poi.brand}</div>
              )}
              {poi.address && <div className="poi-panel__address">{poi.address}</div>}
              <div className="poi-panel__foot">
                <span className="poi-panel__tags">
                  {poi.categories.map((slug) => categoryNames[slug] ?? slug).join(" · ")}
                </span>
                <a className="poi-panel__link" href={poi.osm_url} target="_blank" rel="noreferrer">
                  OpenStreetMap
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}

      {status === "ready" && meta && meta.returned < meta.total && (
        <p className="poi-panel__note">
          Показано {meta.returned} из {meta.total} — список ограничен размером ответа.
        </p>
      )}
    </section>
  );
}
