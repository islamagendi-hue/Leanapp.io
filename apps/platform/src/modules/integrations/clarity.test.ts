import { describe, expect, it } from "vitest";
import { ProviderError } from "./ads/http";
import { INTEGRATIONS } from "./catalog";
import { capabilityState, type CenterInput } from "./center";
import {
  budgetAllows, CLARITY_DAILY_LIMIT, clarityProjectUrl, cleanDimensionValue, fetchInsights, insightsUrl, nextDailyRun, parseInsights, REQUESTS_PER_IMPORT,
  shownField, specFor,
} from "./clarity";
import { providerById, providerRoles } from "./registry";

/** Microsoft's documented sample response (Data Export API page). */
const SAMPLE = [
  {
    metricName: "Traffic",
    information: [
      { totalSessionCount: "9554", totalBotSessionCount: "8369", distantUserCount: "189733", PagesPerSessionPercentage: 1.0931, OS: "Other" },
      { totalSessionCount: "291942", totalBotSessionCount: "31076", distantUserCount: "212836", PagesPerSessionPercentage: 2.2609, OS: "Android" },
    ],
  },
];

describe("Clarity Data Export request", () => {
  it("builds the documented URL and clamps the day range to 1..3", () => {
    expect(insightsUrl(1, "URL")).toBe("https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=1&dimension1=URL");
    expect(insightsUrl(9, "Device")).toContain("numOfDays=3&dimension1=Device");
    expect(insightsUrl(0, "Source")).toContain("numOfDays=1&");
  });

  it("sends the token as a bearer header, never in the URL, and does not retry (each try counts against 10 a day)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;
    await expect(fetchInsights("tok-123", 1, "URL", { fetchImpl, baseDelayMs: 0, sleep: async () => {} })).rejects.toMatchObject({ kind: "transient" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain("tok-123");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("classifies Clarity's documented errors", async () => {
    const answer = (status: number) => (async () => new Response(JSON.stringify({ error: "x" }), { status })) as unknown as typeof fetch;
    const kind = async (status: number): Promise<string[]> => fetchInsights("t", 1, "URL", { fetchImpl: answer(status) }).then(() => [], (e: ProviderError) => [e.kind, e.message]);
    expect(await kind(401)).toEqual(["auth", expect.stringContaining("Data Export")]);
    expect((await kind(403))[0]).toBe("auth");
    expect(await kind(429)).toEqual(["rate_limited", expect.stringContaining("10 requests")]);
    expect((await kind(400))[0]).toBe("permanent");
    await expect(fetchInsights("  ", 1, "URL")).rejects.toMatchObject({ kind: "config" });
  });

  it("refuses to send the token anywhere but Clarity's host", async () => {
    // insightsUrl is fixed; requestJson's allow-list is the second guard.
    const fetchImpl = (async () => Response.json(SAMPLE)) as unknown as typeof fetch;
    await expect(fetchInsights("t", 1, "URL", { fetchImpl })).resolves.toEqual(SAMPLE);
  });
});

describe("parsing the response defensively", () => {
  it("reads the documented sample: numeric strings become numbers, the dimension becomes the row label", () => {
    // Asked for OS isn't one of ours, but the shape is the same: use Device as a stand-in key.
    const rows = parseInsights(SAMPLE.map((b) => ({ ...b, information: b.information.map(({ OS, ...rest }) => ({ ...rest, Device: OS })) })), "Device");
    expect(rows).toEqual([
      { metric: "Traffic", dimensionValue: "Other", values: { totalSessionCount: 9554, totalBotSessionCount: 8369, distantUserCount: 189733, PagesPerSessionPercentage: 1.0931 } },
      { metric: "Traffic", dimensionValue: "Android", values: { totalSessionCount: 291942, totalBotSessionCount: 31076, distantUserCount: 212836, PagesPerSessionPercentage: 2.2609 } },
    ]);
  });

  it("skips what isn't the documented shape and rejects a body that isn't a list", () => {
    expect(() => parseInsights({ error: "nope" }, "URL")).toThrow(ProviderError);
    const rows = parseInsights([
      null, 3, { metricName: 5, information: [] }, { metricName: "Traffic" },
      { metricName: "Dead Click Count", information: [null, [], { url: "https://shop.example/cart?email=a@b.c#x", sessionsCount: "12", label: "not a number", bad: "1e400" }] },
    ], "URL");
    // Case-insensitive dimension key; query string and fragment dropped (they can carry personal data); non-numeric fields dropped.
    expect(rows).toEqual([{ metric: "Dead Click Count", dimensionValue: "https://shop.example/cart", values: { sessionsCount: 12 } }]);
  });

  it("adds up rows that end up with the same label and keeps rows without a dimension value", () => {
    const rows = parseInsights([{ metricName: "Traffic", information: [
      { URL: "https://a.example/p?x=1", totalSessionCount: "2" }, { URL: "https://a.example/p?x=2", totalSessionCount: 3 }, { totalSessionCount: "4" },
    ] }], "URL");
    expect(rows).toEqual([
      { metric: "Traffic", dimensionValue: "https://a.example/p", values: { totalSessionCount: 5 } },
      { metric: "Traffic", dimensionValue: "", values: { totalSessionCount: 4 } },
    ]);
  });

  it("caps values and only strips queries from URLs", () => {
    expect(cleanDimensionValue("Source", "google?x")).toBe("google?x");
    expect(cleanDimensionValue("URL", "x".repeat(600))).toHaveLength(500);
    expect(cleanDimensionValue("Device", { a: 1 })).toBe("");
  });

  it("picks the documented field when present, else names the first numeric field", () => {
    expect(shownField(specFor("Traffic"), { totalBotSessionCount: 1, totalSessionCount: 9 })).toBe("totalSessionCount");
    expect(shownField(specFor("Rage Click Count"), { zeta: 1, alpha: 2 })).toBe("alpha");
    expect(shownField(specFor("Something New"), {})).toBeNull();
    expect(specFor("Scroll Depth")?.key).toBe("scrolldepth");
  });
});

describe("daily budget and schedule", () => {
  it("allows an import only when all its requests fit in Clarity's 10 a day", () => {
    expect(REQUESTS_PER_IMPORT).toBe(3);
    expect(budgetAllows(0)).toBe(true);
    expect(budgetAllows(CLARITY_DAILY_LIMIT - REQUESTS_PER_IMPORT)).toBe(true);
    expect(budgetAllows(CLARITY_DAILY_LIMIT - REQUESTS_PER_IMPORT + 1)).toBe(false);
  });

  it("schedules the next run on the next UTC day", () => {
    expect(nextDailyRun(new Date("2026-10-09T23:59:00Z")).toISOString()).toBe("2026-10-10T01:00:00.000Z");
    expect(nextDailyRun(new Date("2026-12-31T00:10:00+03:00")).toISOString()).toBe("2026-12-31T01:00:00.000Z");
  });

  it("links only to a well-formed project id", () => {
    expect(clarityProjectUrl("3t0wlogvdz")).toBe("https://clarity.microsoft.com/projects/view/3t0wlogvdz/dashboard");
    expect(clarityProjectUrl("../../evil")).toBeNull();
    expect(clarityProjectUrl("")).toBeNull();
  });
});

describe("Clarity in the Integrations Center", () => {
  const empty: CenterInput = { connections: [], postbacks: null, messaging: null, webhooks: null, skan: null, links: null, deepLinks: null, sdk: null, paymentsConnected: null };
  const p = providerById("microsoft_clarity")!;
  const cap = (id: string) => p.capabilities.find((c) => c.id === id)!;

  it("is a built analytics provider with three separate capabilities, data source and service provider", () => {
    expect(p).toMatchObject({ category: "analytics", implementation: "built" });
    expect(p.capabilities.map((c) => [c.id, c.direction])).toEqual([["clarity_identity_bridge", "outbound"], ["clarity_metrics_import", "inbound"], ["clarity_profile_link", "outbound"]]);
    expect(providerRoles(p)).toEqual(["data_source", "service_provider"]);
    const item = INTEGRATIONS.flatMap((g) => g.items).find((i) => i.id === "clarity");
    expect(item).toMatchObject({ state: "beta", path: "settings/integrations/microsoft_clarity" });
  });

  it("reports each capability on its own, and never as verified without a real import", () => {
    expect(capabilityState(p, cap("clarity_metrics_import"), empty).status).toBe("not_configured");
    expect(capabilityState(p, cap("clarity_identity_bridge"), empty).status).toBe("not_configured");
    expect(capabilityState(p, cap("clarity_profile_link"), empty).status).toBe("not_configured");

    const row = { capability: "clarity_metrics_import", status: "unverified" as const, status_detail: null, last_success_at: null, last_error_at: null, last_error: null, data_fresh_through: null };
    const connected = { ...empty, connections: [{ provider: "microsoft_clarity", config: { project_id: "3t0wlogvdz" }, capabilities: [row] }] };
    expect(capabilityState(p, cap("clarity_metrics_import"), connected).status).toBe("unverified");
    // The bridge runs in browsers and the link is not checked with Clarity: neither claims verified.
    expect(capabilityState(p, cap("clarity_identity_bridge"), connected).status).toBe("unverified");
    expect(capabilityState(p, cap("clarity_profile_link"), connected).status).toBe("unverified");
    const failed = { ...connected, connections: [{ ...connected.connections[0], capabilities: [{ ...row, status: "error" as const, last_error: "Clarity refused the API token (HTTP 401)", last_error_at: new Date() }] }] };
    expect(capabilityState(p, cap("clarity_metrics_import"), failed)).toMatchObject({ status: "error", errors: [{ message: expect.stringContaining("401") }] });
    // No project id: the link isn't configured even though the import is.
    expect(capabilityState(p, cap("clarity_profile_link"), { ...connected, connections: [{ ...connected.connections[0], config: {} }] }).status).toBe("not_configured");
  });
});
