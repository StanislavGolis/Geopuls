"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiError, type AroundLayer, type AroundResponse, fetchAround } from "@/lib/api";
import { RADIUS_OPTIONS } from "@/lib/around";

export type AroundPanelProps = {
  city: string;
  /** Точка, вокруг которой считаем: её поставил клик по карте. */
  point: { lat: number; lon: number };
  radiusM: number;
  /** Категория конкурентов: без неё «конкуренты» ничего не значат. */
  category: string;
  /** Человеческое имя категории: slug в заголовке читается плохо. */
  categoryName?: string | null;
  onRadiusChange: (radiusM: number) => void;
  onClose: () => void;
};

/**
 * Что вокруг точки: конкуренты и инфраструктура в радиусе.
 *
 * Как читается: строка — слой, колонки — сколько объектов в круге и как близко ближайший.
 * Проценты и доли площади здесь не показываем: в круге мы их не считаем, а подставить вместо них число
 * объектов и назвать это «долей площади» значило бы соврать. Совпадение с картой — за счёт того, что
 * круг и числа берутся из одного радиуса.
 */
export default function AroundPanel({
  city,
  point,
  radiusM,
  category,
  categoryName,
  onRadiusChange,
  onClose,
}: AroundPanelProps) {
  const [data, setData] = useState<AroundResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    (async () => {
      try {
        const response = await fetchAround({
          city,
          lat: point.lat,
          lon: point.lon,
          category,
          radiusM,
        });
        if (!cancelled) setData(response);
      } catch (exc) {
        if (cancelled) return;
        setData(null);
        setError(
          exc instanceof ApiError
            ? exc
            : new ApiError(0, "Непредвиденная ошибка", exc instanceof Error ? exc.message : String(exc)),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [city, point.lat, point.lon, category, radiusM, reloadToken]);

  // Esc закрывает панель: это модальное окно поверх карты
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const retry = useCallback(() => setReloadToken((value) => value + 1), []);

  return (
    <div
      className="around"
      role="dialog"
      aria-modal="true"
      aria-label="Что вокруг точки"
      data-testid="around-panel"
    >
      <div className="around__card">
        <header className="around__head">
          <div>
            <h2 className="around__title">Что вокруг точки</h2>
            <p className="around__subtitle">
              Радиус {formatDistance(radiusM)} · {categoryName ?? category}
            </p>
          </div>
          <div className="around__actions">
            <button type="button" className="around__button" onClick={retry} data-testid="around-refresh">
              Обновить
            </button>
            <button
              type="button"
              className="around__close"
              onClick={onClose}
              aria-label="Закрыть радиус"
              data-testid="around-close"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="around__radius" role="group" aria-label="Радиус">
          {RADIUS_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className={`around__radius-option${option === radiusM ? " around__radius-option--active" : ""}`}
              aria-pressed={option === radiusM}
              data-testid={`around-radius-${option}`}
              onClick={() => onRadiusChange(option)}
            >
              {formatDistance(option)}
            </button>
          ))}
        </div>

        {error && (
          <div className="around__error" data-testid="around-error">
            <strong>{error.title}</strong>
            <p>{error.detail}</p>
            <button type="button" className="overlay__button" onClick={retry}>
              Повторить
            </button>
          </div>
        )}

        {!error && data && (
          <div className="around__scroll">
            <table className="around__table" data-testid="around-table">
              <thead>
                <tr>
                  <th className="around__th">Показатель</th>
                  <th className="around__th">В радиусе</th>
                  <th className="around__th">Ближайший</th>
                </tr>
              </thead>
              <tbody>
                {data.layers.map((layer) => (
                  <tr className="around__row" key={layer.slug} data-testid={`around-layer-${layer.slug}`}>
                    <th className="around__row-title">
                      {layer.name}
                      {layer.category && (
                        <span className="around__row-unit">{categoryName ?? layer.category}</span>
                      )}
                    </th>
                    <td className="around__value">{formatObjects(layer.objects)}</td>
                    <td className="around__value">{formatNearest(layer)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!error && !data && <p className="around__note">Считаем, что попадает в круг…</p>}

        <p className="around__point mono" data-testid="around-point">
          {point.lat.toFixed(5)}, {point.lon.toFixed(5)} · {radiusM} м
        </p>

        <p className="around__footer-note">
          Наблюдения по данным OSM: круг на карте и числа считаются по одному радиусу. «Нет в радиусе» —
          это отсутствие объектов в данных, а не отсутствие их в городе (ADR 0015).
        </p>
      </div>
    </div>
  );
}

/** Расстояние для человека: сотни метров читаются метрами, дальше — километрами. */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} м`;
  return `${(meters / 1000).toFixed(1).replace(".", ",")} км`;
}

/** «Ближайший» — это имя объекта и расстояние: без имени строка не отвечает на «что там стоит». */
export function formatNearest(layer: AroundLayer): string {
  if (layer.nearest_m === null) return "—";
  const name = layer.nearest_name ?? "объект";
  return `${name} — ${formatDistance(layer.nearest_m)}`;
}

/** Число объектов с правильным окончанием: «1 объект», «2 объекта», «12 объектов». */
export function formatObjects(count: number): string {
  if (count === 0) return "нет в радиусе";
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} объектов`;
  if (mod10 === 1) return `${count} объект`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} объекта`;
  return `${count} объектов`;
}
