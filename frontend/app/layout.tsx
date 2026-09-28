import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";

// Порядок важен: стили MapLibre подключаются до globals.css, чтобы наши правила
// гарантированно перекрывали служебные классы библиотеки (`.maplibregl-map`).
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

/*
 * Шрифты подключаем через next/font: на этапе сборки они скачиваются (Google Fonts, лицензия OFL)
 * и раздаются с нашего домена — в рантайме внешних запросов нет (дизайн-спека §3.1, §7).
 */
const inter = Inter({
  subsets: ["latin", "cyrillic"],
  variable: "--font-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ГЕОПУЛЬС — карта плотности организаций",
  description:
    "Тепловая карта плотности организаций по городам России на открытых данных OpenStreetMap. " +
    "Помогает оценить конкурентную среду и выбрать район для открытия точки.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={`${inter.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
