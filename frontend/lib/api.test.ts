import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, fetchCells, fetchCities, requestJson } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("requestJson", () => {
  it("разбирает успешный ответ", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([{ slug: "tomsk" }])));

    await expect(requestJson<{ slug: string }[]>("/api/v1/meta/cities")).resolves.toEqual([{ slug: "tomsk" }]);
  });

  it("передаёт параметры запроса в URL", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse({ features: [], meta: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchCells({ city: "tomsk", category: "cafe", res: 9 });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/v1/cells?");
    expect(url).toContain("city=tomsk");
    expect(url).toContain("category=cafe");
    expect(url).toContain("res=9");
  });

  it("пробрасывает заголовок accept", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse([]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchCities();

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { accept: "application/json" } });
  });

  it("пустая переменная окружения означает «тот же origin» (деплой за одним доменом)", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_API_BASE_URL = "";
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const api = await import("./api");
      await api.fetchCities();

      const url = String(fetchMock.mock.calls[0][0]);
      expect(url.startsWith(window.location.origin)).toBe(true);
      expect(url).toContain("/api/v1/meta/cities");
    } finally {
      delete process.env.NEXT_PUBLIC_API_BASE_URL;
      vi.resetModules();
    }
  });
});

describe("разбор ошибок RFC 9457", () => {
  it("404 превращается в ApiError с title и detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            type: "about:blank",
            title: "Не найдено",
            status: 404,
            detail: "Город не найден: nowhere",
            instance: "/api/v1/cells",
          },
          404,
        ),
      ),
    );

    const error = await fetchCells({ city: "nowhere", category: "cafe", res: 9 }).catch((exc) => exc);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.title).toBe("Не найдено");
    expect(error.detail).toContain("nowhere");
    expect(error.isDataMissing).toBe(false);
    expect(error.isOffline).toBe(false);
  });

  it("422 отдаёт список ошибок валидации", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            title: "Ошибка валидации",
            status: 422,
            detail: "Параметры запроса не прошли валидацию",
            errors: [{ location: "query.res", message: "Input should be 8 or 9" }],
          },
          422,
        ),
      ),
    );

    const error = await fetchCells({ city: "tomsk", category: "cafe", res: 7 }).catch((exc) => exc);

    expect(error.status).toBe(422);
    expect(error.errors[0].location).toBe("query.res");
  });

  it("503 распознаётся как «данные не собраны»", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { title: "Сервис недоступен", status: 503, detail: "нет собранной сетки" },
          503,
        ),
      ),
    );

    const error = await fetchCells({ city: "tomsk", category: "cafe", res: 9 }).catch((exc) => exc);

    expect(error.isDataMissing).toBe(true);
  });

  it("ошибка сети даёт status 0 и признак «нет связи»", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const error = await fetchCities().catch((exc) => exc);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.isOffline).toBe(true);
    expect(error.title).toContain("Нет связи");
  });
});
