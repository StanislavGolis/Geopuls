import type { Metadata } from "next";

import Report from "@/components/Report";
import { parseUrlState } from "@/lib/urlState";

export const metadata: Metadata = {
  title: "ГЕОПУЛЬС — отчёт",
  description:
    "Отчёт по данным OpenStreetMap: карта, легенда, таблицы и атрибуция. Печатается в PDF средствами браузера.",
  // Отчёт — это документ по конкретному состоянию: в поиске ему делать нечего
  robots: { index: false, follow: false },
};

// Светлая подложка не конкурирует с тепловым слоем (дизайн-спека §4.3, ADR 0002)
const BASEMAP_STYLE_URL =
  process.env.NEXT_PUBLIC_BASEMAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/positron";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ReportPage({ searchParams }: PageProps) {
  const params = await searchParams;
  // Отчёт печатает ту же сцену, что была на экране: состояние приходит теми же параметрами (ADR 0016)
  const state = parseUrlState(params);

  return <Report state={state} styleUrl={BASEMAP_STYLE_URL} />;
}
