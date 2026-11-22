/**
 * Language switch: start-up language, the Japanese copy's shape, and the header toggle that
 * switches every page including Help.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { EN, copyFor, currentLanguage, setLanguage } from "../src/content/copy";
import { JA } from "../src/content/copy.ja";
import { LANG_STORAGE_KEY, detectLanguage, readStoredLanguage, storeLanguage } from "../src/content/language";

describe("detectLanguage", () => {
  it.each([
    [null, ["ja-JP", "en-US"], "ja"],
    [null, ["ja"], "ja"],
    [null, ["en-GB", "ja"], "en"],
    [null, ["fr-FR", "ja-JP"], "ja"],
    [null, ["fr-FR", "de"], "en"],
    [null, [], "en"],
    ["en", ["ja-JP"], "en"],
    ["ja", ["en-US"], "ja"],
    ["xx", ["ja-JP"], "ja"],
  ] as const)("stored %s, browser %j gives %s", (stored, langs, expected) => {
    expect(detectLanguage(stored, langs)).toBe(expected);
  });

  it("always gives en or ja, and a valid stored choice always wins", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), fc.array(fc.string()), (stored, langs) => {
        const lang = detectLanguage(stored, langs);
        expect(["en", "ja"]).toContain(lang);
        if (stored === "en" || stored === "ja") expect(lang).toBe(stored);
      }),
    );
  });

  it("storage helpers never throw when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredLanguage(blocked)).toBeNull();
    expect(() => storeLanguage("ja", blocked)).not.toThrow();
    expect(readStoredLanguage(null)).toBeNull();
  });
});

/** Every leaf of a copy object, with its path, so the two languages can be compared. */
function leaves(value: unknown, path = ""): [string, unknown][] {
  if (typeof value === "string" || typeof value === "function") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${path}[${i}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, path === "" ? k : `${path}.${k}`));
  }
  return [[path, value]];
}

describe("Japanese copy", () => {
  it("has exactly the paths of the English copy, with the same kind of value", () => {
    const en = leaves(EN);
    const ja = leaves(JA);
    expect(ja.map(([p]) => p)).toEqual(en.map(([p]) => p));
    for (const [i, [path, value]] of ja.entries()) {
      expect(typeof value, path).toBe(typeof en[i]![1]);
    }
  });

  it("has no empty text, and its text functions fill in their argument", () => {
    for (const [path, value] of leaves(JA)) {
      if (typeof value === "string") expect(value.trim(), path).not.toBe("");
    }
    expect(JA.talk.remainingToday(3)).toContain("3");
    expect(JA.live.rateLimited(42)).toContain("42");
    expect(JA.family.deleteTitle("X")).toContain("X");
  });

  it("is selected by setLanguage and back", () => {
    setLanguage("ja");
    expect(currentLanguage()).toBe("ja");
    expect(copyFor("ja")).toBe(JA);
    setLanguage("en");
    expect(currentLanguage()).toBe("en");
  });
});

describe("language switch in the shell", () => {
  beforeEach(() => {
    // No config.json: the app runs without the cloud, which is all these tests need.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
    window.localStorage.clear();
    window.location.hash = "";
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.location.hash = "";
    setLanguage("en");
  });

  function goTo(hash: string): void {
    act(() => {
      window.location.hash = hash;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  it("switches the navigation and the Help page, stores the choice and sets the page language", () => {
    render(<App />);
    goTo("#/help");
    expect(screen.getByRole("heading", { level: 1, name: EN.help.heading })).toBeTruthy();
    expect(screen.getByRole("link", { name: EN.shell.nav.help })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: EN.shell.languageToggleLabel }));

    expect(screen.getByRole("heading", { level: 1, name: JA.help.heading })).toBeTruthy();
    expect(screen.getByText(JA.help.sections[0]!.items[0]!)).toBeTruthy();
    expect(screen.getByRole("link", { name: JA.shell.nav.house })).toBeTruthy();
    expect(screen.getByRole("button", { name: JA.shell.mute })).toBeTruthy();
    expect(document.documentElement.lang).toBe("ja");
    expect(window.localStorage.getItem(LANG_STORAGE_KEY)).toBe("ja");

    fireEvent.click(screen.getByRole("button", { name: JA.shell.languageToggleLabel }));
    expect(screen.getByRole("heading", { level: 1, name: EN.help.heading })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
  });

  it("starts in the stored language", () => {
    window.localStorage.setItem(LANG_STORAGE_KEY, "ja");
    render(<App />);
    expect(screen.getByRole("link", { name: JA.shell.nav.help })).toBeTruthy();
    expect(screen.getByRole("button", { name: JA.shell.languageToggleLabel })).toBeTruthy();
  });

  it("translates the scenario buttons of the House page", () => {
    window.localStorage.setItem(LANG_STORAGE_KEY, "ja");
    render(<App />);
    goTo("#/house");
    expect(screen.getByRole("button", { name: JA.scenarios.family_home })).toBeTruthy();
  });
});
