import type { Metadata } from "next";

import MapExplorer from "@/components/MapExplorer";
import { parseUrlState } from "@/lib/urlState";

export const metadata: Metadata = {
  title: "ГЕОПУЛЬС — карта плотности организаций",
  description:
    "Тепловая карта плотности организаций по городам России на открытых данных OpenStreetMap. " +
    "Помогает оценить конкурентную среду и выбрать район для открытия точки.",
};

// Светлая подложка не конкурирует с тепловым слоем (дизайн-спека §4.3, ADR 0002)
const BASEMAP_STYLE_URL =
  process.env.NEXT_PUBLIC_BASEMAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/positron";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function HomePage({ searchParams }: PageProps) {
  const params = await searchParams;
  // Состояние карты живёт в URL: одной ссылкой можно поделиться (раздел 4.3 ТЗ)
  const initialState = parseUrlState(params);

  // Атрибуция и дисклеймер — постоянной строкой внутри карты (см. MapExplorer), а не футером
  return (
    <main className="app">
      <MapExplorer styleUrl={BASEMAP_STYLE_URL} initialState={initialState} />
    </main>
  );
}
