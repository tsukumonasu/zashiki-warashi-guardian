// Static checks (task 13.11): forbidden imports and globals in src/simulation, fetch( call sites,
// WCAG contrast of the design tokens, asset provenance and voice catalog completeness.
// Requirements 5.1, 17.2, 18.4, 18.5, 19.6.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import catalog from "../src/simulation/data/voice-catalog.json";

const DASHBOARD = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(DASHBOARD, "..");
const SRC = join(DASHBOARD, "src");

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/** Source text with comments removed, so prose such as "no Date.now" does not trip a check. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const isSource = (f: string) => /\.(ts|tsx)$/.test(f);

describe("src/simulation purity (Requirement 5.1)", () => {
  const files = filesUnder(join(SRC, "simulation")).filter(isSource);

  const forbiddenImports = /from\s+["'](?:react|react-dom)(?:\/[^"']*)?["']|from\s+["'](?:\.\.\/)+(?:components|hooks|lib|pages)\b[^"']*["']/;
  const forbiddenGlobals: [string, RegExp][] = [
    ["Math.random", /\bMath\.random\b/],
    ["Date", /\bDate\.now\b|\bnew\s+Date\b/],
    ["performance", /\bperformance\.now\b/],
    ["timers", /\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\s*\(/],
    ["window/document", /\b(?:window|document|navigator|globalThis)\s*\.|\b(?:localStorage|sessionStorage)\b/],
    ["network", /(?<![.\w])fetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/],
    ["crypto", /\bcrypto\./],
  ];

  it("finds the simulation sources", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("imports no React, DOM-side or network module", () => {
    const bad = files.filter((f) => forbiddenImports.test(code(f))).map((f) => relative(SRC, f));
    expect(bad).toEqual([]);
  });

  it("uses no time, randomness, timer, DOM or network global", () => {
    const bad: string[] = [];
    for (const f of files) {
      const text = code(f);
      for (const [name, re] of forbiddenGlobals) {
        if (re.test(text)) bad.push(`${relative(SRC, f)}: ${name}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("fetch( call sites (Requirement 19.6)", () => {
  // App.tsx is the composition root: it only hands the global fetch to the api and auth modules.
  const allowed = new Set(["lib/api.ts", "lib/auth.ts", "lib/upload.ts", "App.tsx"]);

  it("calls fetch( only in the allowed modules", () => {
    const bad = filesUnder(SRC)
      .filter(isSource)
      .filter((f) => /\bfetch\s*\(/.test(code(f)))
      .map((f) => relative(SRC, f).split("\\").join("/"))
      .filter((f) => !allowed.has(f));
    expect(bad).toEqual([]);
  });
});

describe("design token contrast (Requirement 17.2)", () => {
  const css = readFileSync(join(SRC, "tokens.css"), "utf8");

  function tokens(): Map<string, string> {
    const map = new Map<string, string>();
    for (const m of css.matchAll(/(--color-[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
      map.set(m[1] as string, (m[2] as string).toLowerCase());
    }
    return map;
  }

  function luminance(hex: string): number {
    const c = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
  }

  function ratio(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  }

  /** Text token, background token, minimum ratio. Normal text needs 4.5, large text 3. */
  const PAIRS: [string, string, number][] = [
    ["--color-ink", "--color-washi", 4.5],
    ["--color-ink", "--color-washi-shade", 4.5],
    ["--color-ink-soft", "--color-washi", 4.5],
    ["--color-ink-soft", "--color-washi-shade", 4.5],
    ["--color-link-on-paper", "--color-washi", 4.5],
    ["--color-danger", "--color-washi", 4.5],
    ["--color-paper-text", "--color-night", 4.5],
    ["--color-paper-text", "--color-night-raised", 4.5],
    ["--color-paper-dim", "--color-night", 4.5],
    ["--color-paper-dim", "--color-night-raised", 4.5],
    ["--color-andon", "--color-night", 4.5],
    ["--color-andon", "--color-night-raised", 4.5],
    ["--color-night", "--color-andon", 4.5], // button label on an amber button
    ["--color-andon", "--color-night-line", 3], // focus ring against a divider/border
  ];

  it("defines every token used in a pair", () => {
    const t = tokens();
    for (const [fg, bg] of PAIRS) {
      expect(t.has(fg), fg).toBe(true);
      expect(t.has(bg), bg).toBe(true);
    }
  });

  it.each(PAIRS)("%s on %s is at least its WCAG minimum", (fg, bg, min) => {
    const t = tokens();
    const r = ratio(t.get(fg) as string, t.get(bg) as string);
    expect(r, `${fg} on ${bg} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
  });
});

describe("asset provenance (Requirement 18.5)", () => {
  const thirdParty = readFileSync(join(ROOT, "docs", "third-party.md"), "utf8");

  for (const dir of ["fonts", "audio"]) {
    it(`names every file of public/${dir} in docs/third-party.md`, () => {
      const missing = filesUnder(join(DASHBOARD, "public", dir))
        .map((f) => f.split(/[\\/]/).pop() as string)
        .filter((name) => !thirdParty.includes(name));
      expect(missing).toEqual([]);
    });
  }
});

describe("voice catalog (Requirement 18.4)", () => {
  const lines = catalog as { id: string; ja: string; en: string }[];

  it("has lines", () => {
    expect(lines.length).toBeGreaterThan(0);
  });

  it("gives every line a non-empty ja and en text", () => {
    const bad = lines
      .filter((l) => typeof l.ja !== "string" || l.ja.trim() === "" || typeof l.en !== "string" || l.en.trim() === "")
      .map((l) => l.id);
    expect(bad).toEqual([]);
  });
});
