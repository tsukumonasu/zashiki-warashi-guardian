/**
 * Which UI language to start with, and where the choice is kept.
 *
 * Pure decision (`detectLanguage`) plus two tiny storage helpers that never throw, because
 * storage can be blocked (private mode, a sandboxed frame). Only the language code is stored.
 */
import type { Lang } from "./copy";

export const LANG_STORAGE_KEY = "warashi.lang";

/**
 * The stored choice wins. Otherwise the first browser language that is Japanese or English
 * decides (`ja`, `ja-JP`, `en-US`, ...). Anything else falls back to English, the source text.
 */
export function detectLanguage(stored: string | null, browserLanguages: readonly string[]): Lang {
  if (stored === "en" || stored === "ja") return stored;
  for (const tag of browserLanguages) {
    const primary = tag.toLowerCase().split("-")[0];
    if (primary === "ja") return "ja";
    if (primary === "en") return "en";
  }
  return "en";
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredLanguage(storage: StorageLike | null = defaultStorage()): string | null {
  try {
    return storage?.getItem(LANG_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function storeLanguage(lang: Lang, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // Not stored: the choice lasts for this page only.
  }
}

/** The browser's preferred languages, most preferred first. */
export function browserLanguages(nav: Pick<Navigator, "languages" | "language"> = navigator): readonly string[] {
  if (Array.isArray(nav.languages) && nav.languages.length > 0) return nav.languages;
  return nav.language ? [nav.language] : [];
}
