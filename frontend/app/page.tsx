import type { Metadata } from "next";

import MapExplorer from "@/components/MapExplorer";

export const metadata: Metadata = {
  title: "ГЕОПУЛЬС — карта плотности организаций",
  description:
    "Тепловая карта плотности организаций по городам России на открытых данных OpenStreetMap. " +
    "Помогает оценить конкурентную среду и выбрать район для открытия точки.",
};

const BASEMAP_STYLE_URL =
  process.env.NEXT_PUBLIC_BASEMAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/liberty";

type PageProps = {
  searchParams: Promise<{ city?: string; category?: string }>;
};

export default async function HomePage({ searchParams }: PageProps) {
  const params = await searchParams;

  return (
    <main className="app">
      <MapExplorer
        styleUrl={BASEMAP_STYLE_URL}
        initialCity={params.city}
        initialCategory={params.category}
      />

      <div className="disclaimer">
        Данные © OpenStreetMap contributors (ODbL). Показаны только объекты, размеченные сообществом, —
        это не прогноз трафика и не оценка доходности.{" "}
        <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">
          Сообщить об объекте
        </a>
      </div>

      <footer className="footer">
        Подложка: OpenFreeMap © OpenMapTiles · данные OpenStreetMap · плотность — по сетке Uber H3 ·
        ГЕОПУЛЬС, 2026
      </footer>
    </main>
  );
}
