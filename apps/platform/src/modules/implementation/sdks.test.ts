import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateSnippets } from "./codegen";
import { SDK_RELEASES, sdkQuickstarts } from "./sdks";

const root = join(__dirname, "../../../../../sdks");
function sources(dir: string, ext: string): string {
  return readdirSync(dir).map((f) => join(dir, f)).map((p) => (statSync(p).isDirectory() ? sources(p, ext) : p.endsWith(ext) && !/test/i.test(p) ? readFileSync(p, "utf8") : "")).join("\n");
}
const SRC = {
  react_native: sources(join(root, "javascript/src"), ".ts"),
  kotlin: sources(join(root, "android"), ".kt"),
  swift: sources(join(root, "ios/Sources"), ".swift"),
  flutter: sources(join(root, "flutter/lib"), ".dart"),
};

// The public API each snippet calls, as declared in the SDK's source.
const API: Record<keyof typeof SRC, RegExp[]> = {
  react_native: [/initialize\(options: AnalyticsOptions\)/, /endpoint\?: string/, /storage\?: StorageAdapter/, /screen\(/, /track\(/, /identify\(/, /export function asyncStorageAdapter/],
  kotlin: [/fun initialize\(context: Context, apiKey: String, options: AnalyticsOptions/, /val endpoint: String/, /fun screen\(screenName: String, properties: Map/, /fun track\(eventName: String, properties: Map/, /fun identify\(userId: String\?, traits: Map/],
  swift: [/public static func initialize\(apiKey: String, options: AnalyticsOptions/, /public var endpoint: String/, /public static func screen\(_ screenName: String/, /public static func track\(_ eventName: String, properties:/, /public static func identify\(_ userId: String\?, traits:/],
  flutter: [/static Future<LeanAppClient> initialize\(\{\s*required String apiKey,\s*String endpoint/, /static void screen\(String screenName/, /static void track\(String eventName, \[Map/, /static void identify\(String\? userId, \[Map/],
};

describe("SDK quickstarts match the SDKs", () => {
  it("every SDK has a release entry and a quickstart", () => {
    const q = sdkQuickstarts({ key: "la_pk_dev_x", endpoint: "https://api.example", currency: "SAR" });
    expect(q.map((x) => x.key)).toEqual(SDK_RELEASES.map((r) => r.key));
    for (const s of q) expect(s.code).toContain("https://api.example");
  });

  it.each(Object.keys(API) as (keyof typeof API)[])("%s: the calls the snippets use exist in the SDK source", (k) => {
    for (const re of API[k]) expect(SRC[k], String(re)).toMatch(re);
  });

  it("no snippet claims a published package or a target API", () => {
    const all = [...sdkQuickstarts({ key: "k", endpoint: "e", currency: "SAR" }).map((x) => x.code), ...Object.values(generateSnippets({ event_name: "e", source: "client", properties: [] }, { currency: "SAR", baseUrl: "b" }))].join("\n");
    expect(all).not.toMatch(/npm install @leanapp|Target API|pub add leanapp/);
    expect(SDK_RELEASES.every((r) => !r.published)).toBe(true);
  });
});
