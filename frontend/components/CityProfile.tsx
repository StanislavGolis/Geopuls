"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiError, fetchCityProfile, type CityProfile as CityProfileData } from "@/lib/api";
import { formatDataVersion, pluralObjects } from "@/lib/format";
import { formatLayerValue, metricLabel } from "@/lib/layers";

export type CityProfileProps = {
  city: string;
  /** Название города для заголовка, пока сводка не загрузилась. */
  cityName?: string;
  onClose: () => void;
};

/**
 * Профиль города: одна страница, объясняющая город за десять секунд.
 *
 * Зачем отдельный экран: менеджер по региональному развитию приходит из другого города и не знает
 * контекста — «Томск это где, 77% пустых ячеек это норма?». Здесь он получает ответ цифрами и может
 * переслать ссылку коллеге.
 *
 * Правила честности (ТЗ §4.2, ADR 0015): у каждой цифры есть единица; «пустая ячейка» объясняется
 * прямо; выводов и рекомендаций нет — только наблюдения.
 */
export default function CityProfile({ city, cityName, onClose }: CityProfileProps) {
  const [data, setData] = useState<CityProfileData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    (async () => {
      try {
        const response = await fetchCityProfile(city);
        if (!cancelled) setData(response);
      } catch (exc) {
        if (cancelled) return;
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
  }, [city, reloadToken]);

  // Esc закрывает панель: это модальное окно, привычный жест должен работать
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
      className="city-profile"
      role="dialog"
      aria-modal="true"
      aria-label="Профиль города"
      data-testid="city-profile"
    >
      <div className="city-profile__card">
        <header className="city-profile__head">
          <div>
            <h2 className="city-profile__title">{data ? data.city.name : cityName ?? city}</h2>
            <p className="city-profile__subtitle">
              {data?.city.region ?? "Профиль города"} · сводка по данным OpenStreetMap
            </p>
          </div>
          <button
            type="button"
            className="city-profile__close"
            onClick={onClose}
            aria-label="Закрыть профиль города"
            data-testid="city-profile-close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {error && (
          <div className="city-profile__error" data-testid="city-profile-error">
            <strong>{error.title}</strong>
            <p>{error.detail}</p>
            <button type="button" className="overlay__button" onClick={retry}>
              Повторить
            </button>
          </div>
        )}

        {!data && !error && <p className="city-profile__note">Загружаем сводку…</p>}

        {data && (
          <div className="city-profile__body">
            <dl className="city-profile__facts" data-testid="city-profile-facts">
              <div>
                <dt>Площадь</dt>
                <dd>{data.city.area_km2} км²</dd>
              </div>
              <div>
                <dt>Сетка</dt>
                <dd className="mono">H3 res {data.grid.res}</dd>
              </div>
              <div>
                <dt>Данные на</dt>
                <dd data-testid="city-profile-version">{formatDataVersion(data.city.data_version) ?? "—"}</dd>
              </div>
              <div>
                <dt>Объектов в категориях</dt>
                <dd>{pluralObjects(data.grid.poi_count)}</dd>
              </div>
            </dl>

            <section className="city-profile__section">
              <h3 className="city-profile__section-title">Охват данных</h3>
              <p className="city-profile__note">
                Ячеек всего {data.grid.cells}, из них с размеченными объектами {data.grid.cells_non_empty} (
                {Math.round(100 - data.grid.empty_share)}%). Пустые ячейки — {data.grid.empty_share}%: это
                значит, что объектов там нет <strong>в OpenStreetMap</strong>, а не что бизнеса нет в городе.
              </p>
            </section>

            <section className="city-profile__section">
              <h3 className="city-profile__section-title">Категории</h3>
              <ul className="city-profile__list" data-testid="city-profile-categories">
                {data.categories.map((item) => (
                  <li className="city-profile__row" key={item.slug}>
                    <span className="city-profile__row-name">{item.name}</span>
                    <span className="city-profile__row-value">
                      {pluralObjects(item.poi_count)}
                      {item.share !== null && <span className="city-profile__share"> · {item.share}%</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="city-profile__section">
              <h3 className="city-profile__section-title">Слои</h3>
              <ul className="city-profile__list" data-testid="city-profile-layers">
                {data.layers.map((layer) => (
                  <li className="city-profile__row" key={layer.slug}>
                    <span className="city-profile__row-name">
                      <span className="city-profile__swatch" style={{ background: layer.color }} aria-hidden="true" />
                      {layer.name}
                    </span>
                    <span className="city-profile__row-value">
                      {metricLabel(layer.metric_kind)}
                      {layer.unit ? `, ${layer.unit}` : ""} · непустых {layer.non_empty_count} из{" "}
                      {layer.covered_count} · максимум {formatLayerValue(layer.max_value, layer.unit)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="city-profile__section">
              <h3 className="city-profile__section-title">Источники</h3>
              <ul className="city-profile__list" data-testid="city-profile-sources">
                {data.sources.map((source) => (
                  <li className="city-profile__row" key={source.slug}>
                    <span className="city-profile__row-name">{source.title}</span>
                    <span className="city-profile__row-value">
                      {source.license ?? "лицензия не указана"}
                      {source.data_version ? ` · выгрузка ${source.data_version}` : ""}
                      {source.attribution_text ? ` · ${source.attribution_text}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <p className="city-profile__footer-note">
              Наблюдения по данным, а не рекомендации: решение о точке принимает человек (ADR 0015).
            </p>
          </div>
        )}
      </div>
    </div>
  );
}