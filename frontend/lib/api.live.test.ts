/**
 * Живая проверка клиента API против запущенного бэкенда.
 *
 * Включается переменной окружения `GEOPULS_LIVE_API_URL` (например `http://127.0.0.1:8000`),
 * иначе тесты пропускаются: в CI бэкенд не поднят, а мокать здесь смысла нет — моки проверяют
 * другие тесты (lib/api.test.ts).
 *
 * Запуск:
 *   cd backend && uv run uvicorn geopuls.main:app --port 8000
 *   $env:GEOPULS_LIVE_API_URL='http://127.0.0.1:8000'; npm test
 */

import { beforeAll, describe, expect, it } from "vitest";

const liveUrl = process.env.GEOPULS_LIVE_API_URL;

describe.skipIf(!liveUrl)("клиент API против живого бэкенда", () => {
  let api: typeof import("./api");

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = liveUrl;
    api = await import("./api");
  });

  it("получает города с версией данных", async () => {
    const cities = await api.fetchCities();

    expect(cities.length).toBeGreaterThan(0);
    expect(cities[0].slug).toBe("tomsk");
    expect(cities[0].data_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cities[0].area_km2).toBeGreaterThan(0);
  });

  it("получает категории с количеством объектов", async () => {
    const categories = await api.fetchCategories();

    // Эндпоинт отдаёт категории всех слоёв (фильтр по слою делает интерфейс), поэтому проверяем
    // не точное число, а наличие категорий конкурентов
    expect(categories.length).toBeGreaterThanOrEqual(8);
    expect(categories.map((item) => item.slug)).toContain("cafe");
  });

  it("получает тепловой слой города и объекты найденной ячейки", async () => {
    const cells = await api.fetchCells({ city: "tomsk", category: "cafe", res: 9 });

    expect(cells.type).toBe("FeatureCollection");
    expect(cells.meta.cell_count).toBeGreaterThan(1000);
    expect(cells.meta.non_empty_count).toBeLessThan(cells.meta.cell_count);
    expect(cells.meta.density_breaks).toHaveLength(5);

    const nonEmpty = cells.features.find((feature) => feature.properties.count > 0);
    expect(nonEmpty).toBeTruthy();

    const pois = await api.fetchPois({
      city: "tomsk",
      cell: nonEmpty!.id,
      res: 9,
      category: "cafe",
    });

    expect(pois.meta.cell).toBe(nonEmpty!.id);
    expect(pois.meta.res).toBe(9);
    expect(pois.meta.total).toBeGreaterThan(0);
    expect(pois.meta.returned).toBeLessThanOrEqual(pois.meta.limit);
    expect(pois.items.length).toBe(pois.meta.returned);
    expect(pois.items[0].categories).toContain("cafe");
    // Объект должен быть пригоден для показа: ссылка на OSM и координаты внутри ячейки
    expect(pois.items[0].osm_url).toMatch(/^https:\/\/www\.openstreetmap\.org\/(node|way|relation)\/\d+$/);
    expect(pois.items[0].lat).toBeGreaterThan(56);
    expect(pois.items[0].lon).toBeGreaterThan(84);
  });

  it("для пустой ячейки возвращает пустой список, а не ошибку", async () => {
    const cells = await api.fetchCells({ city: "tomsk", category: "cafe", res: 9 });
    const empty = cells.features.find((feature) => feature.properties.count === 0);
    expect(empty).toBeTruthy();

    const pois = await api.fetchPois({ city: "tomsk", cell: empty!.id, res: 9, category: "cafe" });

    expect(pois.items).toHaveLength(0);
    expect(pois.meta.total).toBe(0);
  });

  it("ячейка вне сетки города — 404 по контракту problem+json", async () => {
    const error = (await api
      .fetchPois({ city: "tomsk", cell: "8808000001fffff", res: 8 })
      .catch((exc) => exc)) as InstanceType<typeof api.ApiError>;

    expect(error).toBeInstanceOf(api.ApiError);
    expect(error.status).toBe(404);
  });

  it("разбирает ошибку неизвестного города как problem+json", async () => {
    const error = (await api
      .fetchCells({ city: "nowhere", category: "cafe", res: 9 })
      .catch((exc) => exc)) as InstanceType<typeof api.ApiError>;

    expect(error).toBeInstanceOf(api.ApiError);
    expect(error.status).toBe(404);
    expect(error.title).toBe("Не найдено");
  });
});
