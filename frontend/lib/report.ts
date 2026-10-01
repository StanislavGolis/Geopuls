import type { TabId } from "@/lib/urlState";

/** Заголовок и подзаголовок отчёта: что именно показано и по каким данным. */
export type ReportHeading = {
  title: string;
  subtitle: string;
  /** Сцена: по ней строится имя файла при печати (`document.title`). */
  scene: string;
};

const SCENE_NAMES: Record<TabId, string> = {
  competitors: "Конкуренты",
  infrastructure: "Инфраструктура",
  tools: "Инструменты",
  city: "Город",
};

export type ReportHeadingInput = {
  cityName: string;
  tab: TabId;
  /** Название выбранной категории или слоя — то, что именно измерялось. */
  subject: string | null;
  dataVersion: string | null;
  /** Сколько зон в сравнении (0 — инструмент не сравнение). */
  compareCount: number;
  /** Точка радиуса, если открыт этот инструмент. */
  point: { lat: number; lon: number } | null;
  radiusM: number | null;
};

/**
 * Заголовок отчёта: сначала что показано, потом — по каким данным.
 *
 * Формулировки описательные: отчёт — это наблюдения по данным, а не вывод (ADR 0015). Дата выгрузки в
 * подзаголовке обязательна: без неё документ нечем датировать.
 */
export function reportHeading(input: ReportHeadingInput): ReportHeading {
  const scene = SCENE_NAMES[input.tab];
  const version = input.dataVersion ? `данные на ${formatReportDate(input.dataVersion)}` : "дата выгрузки неизвестна";

  if (input.tab === "tools") {
    if (input.point && input.radiusM) {
      const point = `${input.point.lat.toFixed(5)}, ${input.point.lon.toFixed(5)}`;
      return {
        title: `Что вокруг точки: радиус ${input.radiusM} м`,
        subtitle: `${input.cityName} · ${point} · ${input.subject ?? "все слои"} · ${version}`,
        scene: `радиус-${input.radiusM}-м`,
      };
    }
    return {
      title: `Сравнение зон: ${input.compareCount}`,
      subtitle: `${input.cityName} · ${input.subject ?? "показатели слоёв"} · ${version}`,
      scene: "сравнение-зон",
    };
  }

  if (input.tab === "city") {
    return {
      title: "Профиль города",
      subtitle: `${input.cityName} · охват данных, категории, слои · ${version}`,
      scene: "профиль-города",
    };
  }

  const subject = input.subject ? `: ${input.subject}` : "";
  return {
    title: `${scene}${subject}`,
    subtitle: `${input.cityName} · ${version}`,
    scene: scene.toLowerCase(),
  };
}

/** Дата выгрузки в формате «27.09.2026»: та же запись, что в интерфейсе. */
export function formatReportDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

/** Имя файла отчёта: его подставляет браузер в диалоге печати (`document.title`). */
export function reportFileName(cityName: string, scene: string, dataVersion: string | null): string {
  const slug = cityName
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, "-")
    .replace(/^-|-$/g, "");
  const date = dataVersion ? `-${dataVersion}` : "";
  return `geopuls-${slug}-${scene}${date}`;
}
