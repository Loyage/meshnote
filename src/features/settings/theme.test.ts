import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, initializeTheme, readTheme } from "./theme";

describe("theme preferences", () => {
  let dataset: { theme?: string };
  let values: Map<string, string>;
  let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    dataset = {};
    values = new Map();
    storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("defaults to light without changing the document or storage", () => {
    expect(readTheme()).toBe("light");
    expect(storage.getItem).toHaveBeenCalledWith("meshnote.theme");
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(dataset.theme).toBeUndefined();
  });

  it.each(["light", "dark"] as const)("reads an explicit %s preference", (theme) => {
    values.set("meshnote.theme", theme);
    expect(readTheme()).toBe(theme);
  });

  it.each(["", "system", "DARK", "null", '"dark"'])("ignores invalid preference %j", (value) => {
    values.set("meshnote.theme", value);
    expect(readTheme()).toBe("light");
  });

  it("falls back to light when storage reads throw", () => {
    storage.getItem.mockImplementation(() => { throw new Error("Access denied"); });
    expect(readTheme()).toBe("light");
  });

  it("applies and persists both themes, including a switch back to light", () => {
    dataset.theme = "system";
    applyTheme("dark");
    expect(dataset.theme).toBe("dark");
    expect(values.get("meshnote.theme")).toBe("dark");
    applyTheme("light");
    expect(dataset.theme).toBe("light");
    expect(values.get("meshnote.theme")).toBe("light");
    expect(storage.setItem.mock.calls).toEqual([
      ["meshnote.theme", "dark"], ["meshnote.theme", "light"],
    ]);
  });

  it("updates the UI before persisting and tolerates failed writes", () => {
    storage.setItem.mockImplementation(() => {
      expect(dataset.theme).toBe("dark");
      throw new Error("Quota exceeded");
    });
    expect(() => applyTheme("dark")).not.toThrow();
    expect(dataset.theme).toBe("dark");
  });

  it.each(["light", "dark"] as const)("initializes the stored %s theme", (theme) => {
    values.set("meshnote.theme", theme);
    expect(initializeTheme()).toBe(theme);
    expect(dataset.theme).toBe(theme);
  });

  it("initializes missing or invalid preferences to light", () => {
    expect(initializeTheme()).toBe("light");
    expect(dataset.theme).toBe("light");
    values.set("meshnote.theme", "system");
    dataset.theme = "dark";
    expect(initializeTheme()).toBe("light");
    expect(dataset.theme).toBe("light");
    expect(values.get("meshnote.theme")).toBe("light");
  });

  it("initializes safely when storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(initializeTheme()).toBe("light");
    expect(dataset.theme).toBe("light");
    expect(() => applyTheme("dark")).not.toThrow();
    expect(dataset.theme).toBe("dark");
  });
});
