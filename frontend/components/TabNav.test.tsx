import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TabNav from "./TabNav";
import { TAB_IDS } from "@/lib/urlState";

describe("TabNav", () => {
  it("показывает все вкладки-сцены и отмечает активную", () => {
    render(<TabNav active="infrastructure" onChange={vi.fn()} />);

    const nav = screen.getByRole("tablist");
    expect(nav).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(TAB_IDS.length);
    expect(screen.getByTestId("tab-infrastructure").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("tab-competitors").getAttribute("aria-selected")).toBe("false");
  });

  it("передаёт выбранную вкладку наружу", () => {
    const onChange = vi.fn();
    render(<TabNav active="competitors" onChange={onChange} />);

    fireEvent.click(screen.getByTestId("tab-city"));

    expect(onChange).toHaveBeenCalledWith("city");
  });

  it("названия вкладок объясняют, что внутри", () => {
    render(<TabNav active="competitors" onChange={vi.fn()} />);

    // Названия — часть продукта: по ним пользователь понимает, где что искать (ADR 0016)
    expect(screen.getByTestId("tab-competitors").textContent).toBe("Конкуренты");
    expect(screen.getByTestId("tab-infrastructure").textContent).toBe("Инфраструктура");
    expect(screen.getByTestId("tab-tools").textContent).toBe("Инструменты");
    expect(screen.getByTestId("tab-city").textContent).toBe("Город");
  });
});
