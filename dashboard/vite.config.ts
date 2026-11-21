import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

const PRECACHE_DIRS = ["audio", "illustrations", "fonts"];
const LIST_PATTERN = /\/\*__PRECACHE_LIST__\*\/[\s\S]*?\/\*__END_PRECACHE_LIST__\*\//;

/** Lists every file under `dir` as a URL path such as `/audio/greet.wav`. */
function listFiles(dir: string, urlPrefix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.sort().flatMap((name) => {
    const full = join(dir, name);
    const url = posix.join(urlPrefix, name);
    return statSync(full).isDirectory() ? listFiles(full, url) : [url];
  });
}

/**
 * Writes the pre-cache list into the built `sw.js`. Public files are copied unchanged, so the
 * plugin rewrites the copy in the output folder after the bundle is written.
 */
export function precacheListPlugin(): Plugin {
  let publicDir = "";
  let outDir = "";
  return {
    name: "warashi-precache-list",
    apply: "build",
    configResolved(config) {
      publicDir = config.publicDir;
      outDir = join(config.root, config.build.outDir);
    },
    writeBundle() {
      const urls = ["/", ...PRECACHE_DIRS.flatMap((d) => listFiles(join(publicDir, d), `/${d}`))];
      const swPath = join(outDir, "sw.js");
      const source = readFileSync(swPath, "utf8");
      const list = `/*__PRECACHE_LIST__*/ ${JSON.stringify(urls)} /*__END_PRECACHE_LIST__*/`;
      writeFileSync(swPath, source.replace(LIST_PATTERN, () => list));
    },
  };
}

// JSX is compiled by Vite's built-in esbuild, so no React plugin package is needed.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  plugins: [precacheListPlugin()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    passWithNoTests: true,
    // A test that blocks on a fake fails instead of hanging CI.
    testTimeout: 15000,
  },
});
