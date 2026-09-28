import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "ГЕОПУЛЬС — карта плотности организаций",
  description:
    "Тепловая карта плотности организаций по городам России на открытых данных OpenStreetMap. " +
    "Помогает оценить конкурентную среду и выбрать район для открытия точки.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
