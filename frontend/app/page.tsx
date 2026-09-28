import MapView from "@/components/MapView";

/** Этап 0: данные синтетические. Дата реальной выгрузки OSM появится вместе с импортёром (Этап 2). */
const DATA_VERSION = process.env.NEXT_PUBLIC_DATA_VERSION ?? "демо-данные (Этап 0)";

const BASEMAP_STYLE_URL =
  process.env.NEXT_PUBLIC_BASEMAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/liberty";

const CATEGORIES = [
  { slug: "cafe", label: "Кофейни и кафе" },
  { slug: "restaurant", label: "Рестораны" },
  { slug: "bar", label: "Бары и пабы" },
  { slug: "pharmacy", label: "Аптеки" },
  { slug: "beauty", label: "Салоны красоты" },
  { slug: "fitness", label: "Фитнес и спортзалы" },
  { slug: "grocery", label: "Продукты" },
  { slug: "pickup_point", label: "Пункты выдачи заказов" },
];

export default function HomePage() {
  return (
    <main className="app">
      <header className="topbar">
        <span className="topbar__brand">ГЕОПУЛЬС</span>

        <label className="topbar__control">
          Город
          <select defaultValue="tomsk" aria-label="Город">
            <option value="tomsk">Томск</option>
          </select>
        </label>

        <label className="topbar__control">
          Категория
          <select defaultValue="cafe" aria-label="Категория">
            {CATEGORIES.map((category) => (
              <option key={category.slug} value={category.slug}>
                {category.label}
              </option>
            ))}
          </select>
        </label>

        <span className="topbar__spacer" />

        <span className="topbar__meta">Данные: {DATA_VERSION}</span>
      </header>

      <MapView styleUrl={BASEMAP_STYLE_URL} />

      <div className="disclaimer">
        Данные © OpenStreetMap contributors (ODbL). Показаны только объекты, размеченные сообществом, —
        это не прогноз трафика и не оценка доходности.{" "}
        <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">
          Сообщить об объекте
        </a>
      </div>

      <footer className="footer">
        Подложка: OpenFreeMap © OpenMapTiles · данные OpenStreetMap · ГЕОПУЛЬС, 2026
      </footer>
    </main>
  );
}
