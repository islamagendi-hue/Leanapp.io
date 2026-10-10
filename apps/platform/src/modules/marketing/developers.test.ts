import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SDK_RELEASES } from "@/modules/implementation/sdks";
import { developersCopy, SDK_FACTS, SDK_IDS, SDK_SNIPPETS, SECTION_IDS, sdkPublished, sdkStatus, type SdkId } from "./developers";
import { landingCopy } from "./landing";

/** The shape of a value: keys and array lengths, with every string replaced by "s". */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
  return typeof v;
}

const root = join(__dirname, "../../../../../sdks");
function sources(dir: string, ext: string): string {
  return readdirSync(dir).map((f) => join(dir, f)).map((p) => (statSync(p).isDirectory() ? sources(p, ext) : p.endsWith(ext) && !/test/i.test(p) ? readFileSync(p, "utf8") : "")).join("\n");
}
const SRC: Record<SdkId, string> = {
  javascript: sources(join(root, "javascript/src"), ".ts"),
  android: sources(join(root, "android"), ".kt"),
  ios: sources(join(root, "ios/Sources"), ".swift"),
  flutter: sources(join(root, "flutter/lib"), ".dart"),
};
/** How each language declares a public method of the Analytics facade. */
const DECL: Record<SdkId, (m: string) => RegExp> = {
  javascript: (m) => new RegExp(`^\\s+(async )?${m}[(:]`, "m"),
  android: (m) => new RegExp(`fun ${m}\\(`),
  ios: (m) => new RegExp(`public static func ${m}\\(`),
  flutter: (m) => new RegExp(`static [^=]*\\b${m}\\(`),
};

describe("developer guide content", () => {
  it("says the same thing in Arabic and English, section for section", () => {
    const en = developersCopy("en");
    const ar = developersCopy("ar");
    expect(shape(ar)).toEqual(shape(en));
    expect(Object.keys(en.sections)).toEqual(SECTION_IDS);
    expect(ar.dir).toBe("rtl");
    expect(en.dir).toBe("ltr");
    // Code identifiers in the copy are the same in both languages.
    const idents = (s: string) => (s.match(/\b[a-z]+(?:_[a-z]+)+\b|la_[ps]k_[a-z]*/g) ?? []).sort();
    expect(idents(JSON.stringify(ar.events.rules))).toEqual(idents(JSON.stringify(en.events.rules)));
    expect(idents(JSON.stringify(ar.quickstart))).toEqual(idents(JSON.stringify(en.quickstart)));
  });

  it("lists the four SDKs, in step with the dashboard's release status", () => {
    expect(SDK_IDS).toEqual(["javascript", "android", "ios", "flutter"]);
    expect(SDK_IDS.map((id) => SDK_FACTS[id].release)).toEqual(SDK_RELEASES.map((r) => r.key));
    for (const id of SDK_IDS) {
      const r = SDK_RELEASES.find((x) => x.key === SDK_FACTS[id].release)!;
      expect(sdkPublished(id)).toBe(r.published);
      if (!r.published) {
        expect(sdkStatus("en", id)).toMatch(/available from us during onboarding/);
        expect(sdkStatus("ar", id)).toContain("أثناء الإعداد");
      }
    }
  });

  it("never shows an install command for a package that isn't published", () => {
    const code = Object.values(SDK_SNIPPETS).flatMap((s) => Object.values(s)).join("\n");
    if (SDK_IDS.every((id) => !sdkPublished(id))) {
      expect(code).not.toMatch(/npm (i|install) |yarn add|pod '|flutter pub add|dart pub add|implementation\("io\.leanapp|\.package\(url/);
    }
    // Apps get public keys only.
    expect(code).not.toContain("la_sk_");
    expect(code).toContain("la_pk_dev_");
  });

  it.each(SDK_IDS)("%s: every Analytics call in the snippets exists in the SDK source", (id) => {
    const calls = new Set([...Object.values(SDK_SNIPPETS[id]).join("\n").matchAll(/Analytics\.(\w+)\(/g)].map((m) => m[1]));
    expect(calls.size).toBeGreaterThan(5);
    for (const m of calls) expect(SRC[id], `${id}: Analytics.${m}`).toMatch(DECL[id](m));
  });

  it("uses options the SDKs have", () => {
    expect(SRC.javascript).toMatch(/consentDefault\?:/);
    expect(SRC.javascript).toMatch(/appVersion\?: string/);
    expect(SRC.android).toMatch(/val debug: Boolean/);
    expect(SRC.ios).toMatch(/public var debug: Bool/);
    expect(SRC.flutter).toMatch(/bool debug = false/);
    expect(SRC.flutter).toMatch(/String\? appBuild/);
  });

  it("says plainly that deferred deep links are not in the SDKs", () => {
    expect(developersCopy("en").deepLinks.points.join(" ")).toMatch(/Deferred deep links .* not called by the SDKs yet/);
    expect(developersCopy("ar").deepLinks.points.join(" ")).toContain("لا تستدعيها الحزم بعد");
  });

  it("is linked from the landing page in both languages", () => {
    expect(landingCopy("en").nav.developers).toBe("Developers");
    expect(landingCopy("ar").nav.developers).toBe("للمطوّرين");
    expect(landingCopy("ar").developers.points).toHaveLength(landingCopy("en").developers.points.length);
  });
});
