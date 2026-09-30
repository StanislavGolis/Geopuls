"use client";

import { TAB_IDS, type TabId } from "@/lib/urlState";

export type TabNavProps = {
  active: TabId;
  onChange: (tab: TabId) => void;
};

/**
 * Вкладки-сцены: каждая отвечает на свой вопрос и красит карту своим слоем (ADR 0016).
 *
 * Почему сцены, а не ещё один переключатель слоёв: пять заливок на одной карте нечитаемы, поэтому
 * раньше основу нельзя было менять вовсе. Вкладка даёт каждому слою побыть основой — но по одному.
 */
const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: "competitors", label: "Конкуренты", hint: "Плотность выбранной категории: где её много, а где нет" },
  { id: "infrastructure", label: "Инфраструктура", hint: "Остановки, парковки, точки притяжения, жильё, промзоны, пешеходные пути" },
  { id: "tools", label: "Инструменты", hint: "Радиус вокруг точки и сравнение зон" },
  { id: "city", label: "Город", hint: "Сводка по данным города: охват, категории, слои, источники" },
];

export default function TabNav({ active, onChange }: TabNavProps) {
  // Список вкладок сверяем с типом: забыть добавить вкладку в разметку нельзя
  const known = new Set<TabId>(TAB_IDS);

  return (
    <nav className="tabs" role="tablist" aria-label="Разделы">
      {TABS.filter((tab) => known.has(tab.id)).map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={`tabs__tab${tab.id === active ? " tabs__tab--active" : ""}`}
          data-testid={`tab-${tab.id}`}
          title={tab.hint}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
