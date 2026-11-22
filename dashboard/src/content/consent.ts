/**
 * Consent notices by version and language (docs/schema.md, `GET /me`).
 *
 * Files under `content/consent/`: `<version>.md` is the English source, `<version>.<lang>.md` a
 * translation of the same notice. A translation is the same version, so the version a family
 * member accepts does not depend on the language they read. Pure: the page passes in the files.
 */
import { LANGS, type Lang } from "./copy";

export type Notices = Readonly<Record<string, Partial<Record<Lang, string>>>>;

const TRANSLATIONS = LANGS.filter((l) => l !== "en");

/** Groups bundled files (`path → text`) by version. Only a trailing known language counts as one. */
export function noticesFromFiles(files: Readonly<Record<string, string>>): Notices {
  const out: Record<string, Partial<Record<Lang, string>>> = {};
  for (const [path, text] of Object.entries(files)) {
    const name = path.replace(/^.*\//, "").replace(/\.md$/, "");
    const dot = name.lastIndexOf(".");
    const suffix = dot > 0 ? name.slice(dot + 1) : "";
    const lang: Lang = (TRANSLATIONS as readonly string[]).includes(suffix) ? (suffix as Lang) : "en";
    const version = lang === "en" ? name : name.slice(0, dot);
    (out[version] ??= {})[lang] = text;
  }
  return out;
}

/**
 * The text to show for `version`: the requested language, else English. Undefined when the
 * English source is missing, because then the version is not one this dashboard can offer.
 */
export function noticeFor(notices: Notices, version: string, lang: Lang): string | undefined {
  const texts = notices[version];
  if (texts?.en === undefined) return undefined;
  return texts[lang] ?? texts.en;
}
