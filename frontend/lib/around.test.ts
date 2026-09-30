import { describe, expect, it } from "vitest";

import { DEFAULT_RADIUS_M, RADIUS_OPTIONS, buildRadiusCircle, isValidRadius } from "./around";

describe("buildRadiusCircle", () => {
  const LAT = 56.4847;
  const LON = 84.9482;
  const RADIUS = 500;

  it("строит замкнутый полигон вокруг точки", () => {
    const circle = buildRadiusCircle(LAT, LON, RADIUS);
    const ring = circle.geometry.coordinates[0]!;

    expect(ring.length).toBeGreaterThan(32);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(circle.properties?.radius_m).toBe(RADIUS);
  });

  it("крайние точки стоят на заданном расстоянии от центра", () => {
    const ring = buildRadiusCircle(LAT, LON, RADIUS).geometry.coordinates[0]!;
    const latDelta = RADIUS / 111_320;

    const lats = ring.map(([, lat]) => lat);
    const lons = ring.map(([lon]) => lon);

    // Северная и южная точки: смещение по широте — это и есть радиус в градусах
    expect(Math.max(...lats) - LAT).toBeCloseTo(latDelta, 5);
    expect(LAT - Math.min(...lats)).toBeCloseTo(latDelta, 5);
    // Долгота короче широтного градуса: без cos(lat) круг был бы вытянут
    const lonDelta = Math.max(...lons) - LON;
    expect(lonDelta).toBeGreaterThan(latDelta);
    expect(lonDelta).toBeCloseTo(latDelta / Math.cos((LAT * Math.PI) / 180), 3);
  });

  it("больший радиус даёт больший круг", () => {
    const small = buildRadiusCircle(LAT, LON, 100).geometry.coordinates[0]!;
    const large = buildRadiusCircle(LAT, LON, 2000).geometry.coordinates[0]!;

    const spanOf = (ring: GeoJSON.Position[]) =>
      Math.max(...ring.map(([, lat]) => lat)) - Math.min(...ring.map(([, lat]) => lat));

    expect(spanOf(large)).toBeGreaterThan(spanOf(small));
  });
});

describe("isValidRadius", () => {
  it("принимает значения из списка и отвергает остальное", () => {
    expect(DEFAULT_RADIUS_M).toBe(500);
    for (const option of RADIUS_OPTIONS) {
      expect(isValidRadius(option)).toBe(true);
    }
    expect(isValidRadius(50)).toBe(false);
    expect(isValidRadius(5000)).toBe(false);
    expect(isValidRadius(Number.NaN)).toBe(false);
    expect(isValidRadius(null)).toBe(false);
  });
});
