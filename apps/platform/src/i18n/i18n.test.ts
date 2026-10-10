import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AR } from "./ar";
import { makeT, pickLang } from "./translate";

const SRC = path.resolve(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "i18n" ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

/** Every literal passed to t("…") or msg("…") in the code. */
function keys(): { key: string; file: string }[] {
  const out: { key: string; file: string }[] = [];
  const re = /\b(?:t|msg)\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const file of files(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(re)) {
      // A double-quoted literal is valid JSON as is; a single-quoted one needs its quotes swapped.
      const body = m[1] === '"' ? m[2] : m[2].replace(/\\'/g, "'").replace(/(^|[^\\])"/g, '$1\\"');
      out.push({ key: JSON.parse(`"${body}"`), file: path.relative(SRC, file) });
    }
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("Arabic translations", () => {
  it("cover every string the UI translates", () => {
    const missing = keys().filter((k) => !(k.key in AR)).map((k) => `${k.file}: ${k.key}`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it("keep the same placeholders", () => {
    const wrong = Object.entries(AR).filter(([en, ar]) => placeholders(en).join() !== placeholders(ar).join()).map(([en]) => en);
    expect(wrong).toEqual([]);
  });

  it("are not left empty or in English", () => {
    const bad = Object.entries(AR).filter(([, ar]) => !ar.trim() || !/[؀-ۿ]/.test(ar)).map(([en]) => en);
    expect(bad).toEqual([]);
  });
});

describe("translate", () => {
  it("falls back to English and fills placeholders", () => {
    const t = makeT({ "Hello {name}": "مرحبًا {name}" });
    expect(t("Hello {name}", { name: "Sara" })).toBe("مرحبًا Sara");
    expect(t("Not translated {n}", { n: 3 })).toBe("Not translated 3");
    expect(makeT(null)("Hello {name}", { name: "Sara" })).toBe("Hello Sara");
  });

  it("picks the cookie, else the browser, with Arabic by default", () => {
    expect(pickLang("en", "ar-SA")).toBe("en");
    expect(pickLang("ar", "en-US")).toBe("ar");
    expect(pickLang(undefined, "en-US,en;q=0.9")).toBe("en");
    expect(pickLang(undefined, "ar-EG,ar;q=0.9")).toBe("ar");
    expect(pickLang(undefined, null)).toBe("ar");
    expect(pickLang("xx", "fr-FR")).toBe("en");
  });
});
