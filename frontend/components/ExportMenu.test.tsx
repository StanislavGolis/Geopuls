import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ExportMenu from "./ExportMenu";

function renderMenu(overrides: Partial<Parameters<typeof ExportMenu>[0]> = {}) {
  const onExportPng = vi.fn();
  const onExportCsv = vi.fn();
  const view = render(
    <ExportMenu onExportPng={onExportPng} onExportCsv={onExportCsv} {...overrides} />,
  );
  return { ...view, onExportPng, onExportCsv };
}

describe("ExportMenu", () => {
  it("сначала показывает только кнопку «Экспорт»", () => {
    renderMenu();

    expect(screen.getByTestId("export").textContent).toContain("Экспорт");
    expect(screen.queryByTestId("export-png")).toBeNull();
    expect(screen.queryByTestId("export-csv")).toBeNull();
  });

  it("раскрывает меню и отдаёт оба формата", () => {
    const { onExportPng, onExportCsv } = renderMenu();

    fireEvent.click(screen.getByTestId("export"));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.click(screen.getByTestId("export-png"));
    expect(onExportPng).toHaveBeenCalledTimes(1);
    expect(onExportCsv).not.toHaveBeenCalled();
    expect(screen.queryByTestId("export-png")).toBeNull();

    fireEvent.click(screen.getByTestId("export"));
    fireEvent.click(screen.getByTestId("export-csv"));
    expect(onExportCsv).toHaveBeenCalledTimes(1);
  });

  it("помечает состояние для скринридеров", () => {
    renderMenu();

    expect(screen.getByTestId("export").getAttribute("aria-haspopup")).toBe("menu");
    expect(screen.getByTestId("export").getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByTestId("export"));

    expect(screen.getByTestId("export").getAttribute("aria-expanded")).toBe("true");
  });

  it("закрывается по Escape и возвращает фокус на кнопку", () => {
    renderMenu();

    fireEvent.click(screen.getByTestId("export"));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("export"));
  });

  it("закрывается по клику вне меню", () => {
    renderMenu();

    fireEvent.click(screen.getByTestId("export"));
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("пока подготовки файла пишет «Готовим…» и блокируется, если данных нет", () => {
    renderMenu({ busy: true, disabled: true });

    expect(screen.getByTestId("export").textContent).toContain("Готовим…");
    expect((screen.getByTestId("export") as HTMLButtonElement).disabled).toBe(true);
  });
});
