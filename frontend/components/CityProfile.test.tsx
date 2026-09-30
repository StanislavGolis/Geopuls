import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import CityProfile from "./CityProfile";
import { ApiError, type CityProfile as CityProfileData, fetchCityProfile } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchCityProfile: vi.fn() };
});

const PROFILE: CityProfileData = {
  type: "CityProfile",
  city: {
    slug: "tomsk",
    name: "Томск",
    region: "Томская область",
    h3_res: 9,
    area_km2: 176.8,
    center: { lat: 56.4736, lon: 85.024 },
    bbox: { min_lat: 56.379, min_lon: 84.828, max_lat: 56.571, max_lon: 85.15 },
    data_version: "2026-09-27",
    updated_at: "2026-09-28T12:39:25Z",
  },
  grid: { res: 9, cells: 1538, cells_non_empty: 341, empty_share: 77.8, poi_count: 1976 },
  categories: [
    { slug: "grocery", name: "Продукты", color: "#1f6fb2", poi_count: 496, share: 25.1 },
    { slug: "cafe", name: "Кофейни и кафе", color: "#1f6fb2", poi_count: 250, share: 12.7 },
  ],
  layers: [
    {
      slug: "competitors",
      name: "Конкуренты (объекты по категориям)",
      metric_kind: "density",
      unit: "POI/км²",
      color: "#1f6fb2",
      covered_count: 1538,
      non_empty_count: 341,
      max_value: 76.8817,
    },
    {
      slug: "transport_stops",
      name: "Транспорт: остановки и станции",
      metric_kind: "density",
      unit: "ост/км²",
      color: "#0f766e",
      covered_count: 1538,
      non_empty_count: 321,
      max_value: 51.2547,
    },
  ],
  sources: [
    {
      slug: "osm",
      title: "OpenStreetMap (Geofabrik)",
      license: "ODbL 1.0",
      license_url: null,
      attribution_text: "© OpenStreetMap contributors",
      citation: null,
      source_url: null,
      data_version: "2026-09-27",
    },
  ],
};

function renderProfile(props: Partial<React.ComponentProps<typeof CityProfile>> = {}) {
  return render(<CityProfile city="tomsk" cityName="Томск" onClose={vi.fn()} {...props} />);
}

describe("CityProfile", () => {
  beforeEach(() => {
    vi.mocked(fetchCityProfile).mockResolvedValue(PROFILE);
  });

  it("показывает город, площадь, сетку и дату данных", async () => {
    renderProfile();

    expect(await screen.findByTestId("city-profile-facts")).toBeTruthy();
    expect(screen.getByText("176.8 км²")).toBeTruthy();
    expect(screen.getByText("H3 res 9")).toBeTruthy();
    expect(screen.getByTestId("city-profile-version").textContent).toContain("27.09.2026");
  });

  it("объясняет пустые ячейки прямо, а не оставляет догадываться", async () => {
    renderProfile();

    const note = await screen.findByText(/Пустые ячейки —/);

    expect(note.textContent).toContain("77.8%");
    expect(note.textContent).toContain("в OpenStreetMap");
  });

  it("показывает категории с числом объектов и долей", async () => {
    renderProfile();

    const categories = await screen.findByTestId("city-profile-categories");

    expect(categories.textContent).toContain("Продукты");
    expect(categories.textContent).toContain("496 объект");
    expect(categories.textContent).toContain("25.1%");
  });

  it("показывает слои с метрикой, покрытием и максимумом в единицах слоя", async () => {
    renderProfile();

    const layers = await screen.findByTestId("city-profile-layers");

    expect(layers.textContent).toContain("Транспорт: остановки и станции");
    expect(layers.textContent).toContain("Плотность, ост/км²");
    expect(layers.textContent).toContain("непустых 321 из 1538");
    expect(layers.textContent).toContain("51.3 ост/км²");
  });

  it("показывает источники с лицензией и версией выгрузки", async () => {
    renderProfile();

    const sources = await screen.findByTestId("city-profile-sources");

    expect(sources.textContent).toContain("OpenStreetMap (Geofabrik)");
    expect(sources.textContent).toContain("ODbL 1.0");
    expect(sources.textContent).toContain("выгрузка 2026-09-27");
  });

  it("говорит, что это наблюдения, а не рекомендации", async () => {
    renderProfile();

    expect(await screen.findByText(/Наблюдения по данным, а не рекомендации/)).toBeTruthy();
  });

  it("показывает ошибку и умеет повторить запрос", async () => {
    vi.mocked(fetchCityProfile).mockRejectedValueOnce(
      new ApiError(503, "Сервис недоступен", "нет собранной сетки"),
    );

    renderProfile();

    const error = await screen.findByTestId("city-profile-error");
    expect(error.textContent).toContain("Сервис недоступен");

    vi.mocked(fetchCityProfile).mockResolvedValueOnce(PROFILE);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    await waitFor(() => expect(screen.getByTestId("city-profile-facts")).toBeTruthy());
  });
});
