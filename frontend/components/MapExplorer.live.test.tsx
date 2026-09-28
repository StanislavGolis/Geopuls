/**
 * Проверка `MapExplorer` против **живого** API (без моков `lib/api`).
 *
 * Дополняет `MapExplorer.test.tsx` (там API замокан): здесь проверяется реальная связка
 * «компонент → HTTP → бэкенд» — выбор категории по данным, легенда с настоящими границами классов
 * и подпись версии данных. Запуск:
 *
 *   cd backend && uv run uvicorn geopuls.main:app --port 8000
 *   cd frontend && $env:GEOPULS_LIVE_API_URL='http://127.0.0.1:8000'; npm test
 *
 * WebGL-часть (MapLibre) не проверяется — в jsdom нет WebGL; визуальная проверка остаётся ручной.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const liveUrl = process.env.GEOPULS_LIVE_API_URL;

// Адрес API нужно подставить до загрузки модулей (lib/api читает переменную при импорте)
vi.hoisted(() => {
  if (process.env.GEOPULS_LIVE_API_URL) {
    process.env.NEXT_PUBLIC_API_BASE_URL = process.env.GEOPULS_LIVE_API_URL;
  }
});

vi.mock("./MapView", () => ({
  default: ({ cells }: { cells: { features: unknown[] } | null }) => (
    <div data-testid="map">features={cells?.features.length ?? 0}</div>
  ),
}));

const { default: MapExplorer } = await import("./MapExplorer");

describe.skipIf(!liveUrl)("MapExplorer против живого API", () => {
  it("загружает реальный город, тепловой слой и показывает версию данных", async () => {
    render(<MapExplorer styleUrl="style.json" />);

    const map = await screen.findByTestId("map", undefined, { timeout: 15_000 });
    await waitFor(() => expect(map.textContent).not.toContain("features=0"), { timeout: 15_000 });

    const features = Number(map.textContent?.replace(/\D/g, "") ?? "0");
    expect(features).toBeGreaterThan(1000), "сетка Томска должна содержать больше тысячи ячеек";

    expect(screen.getByTestId("data-version").textContent).toMatch(/Данные OSM на \d{4}-\d{2}-\d{2}/);
    expect(screen.getByTestId("resolution").textContent).toContain("res 9");

    // Легенда строится по реальным границам классов, а не по заглушке
    expect(screen.getByText(/0 — нет размеченных объектов/)).toBeTruthy();
    expect(screen.getByText(/более \d/)).toBeTruthy();
    expect(screen.queryByTestId("error")).toBeNull();
  }, 30_000);
});
