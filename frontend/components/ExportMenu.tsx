"use client";

import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type ExportMenuProps = {
  /** Пока данные не загружены — экспортировать нечего. */
  disabled?: boolean;
  /** Идёт подготовка файла (PNG собирается асинхронно). */
  busy?: boolean;
  onExportPng: () => void;
  onExportCsv: () => void;
};

/**
 * Меню «Экспорт»: одна кнопка в шапке вместо трёх (дизайн-спека §4.9).
 *
 * Доступность: `aria-haspopup="menu"`, `aria-expanded`, закрытие по `Escape` с возвратом фокуса
 * на кнопку, перемещение между пунктами стрелками, закрытие по клику вне меню.
 */
export default function ExportMenu({ disabled = false, busy = false, onExportPng, onExportCsv }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  const focusItem = (index: number) => {
    const items = itemsRef.current.filter(Boolean);
    if (items.length === 0) return;
    const next = (index + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="menu" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        className="topbar__button"
        data-testid="export"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Download size={16} aria-hidden="true" />
        <span>{busy ? "Готовим…" : "Экспорт"}</span>
      </button>

      {open && (
        <div className="menu__list" role="menu" aria-label="Экспорт текущего вида">
          <button
            type="button"
            role="menuitem"
            className="menu__item"
            data-testid="export-png"
            ref={(element) => {
              itemsRef.current[0] = element;
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") focusItem(1);
              if (event.key === "ArrowUp") focusItem(-1);
            }}
            onClick={() => run(onExportPng)}
          >
            PNG карты
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu__item"
            data-testid="export-csv"
            ref={(element) => {
              itemsRef.current[1] = element;
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") focusItem(0);
              if (event.key === "ArrowUp") focusItem(0);
            }}
            onClick={() => run(onExportCsv)}
          >
            CSV ячеек
          </button>
        </div>
      )}
    </div>
  );
}
