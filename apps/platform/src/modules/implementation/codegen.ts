/**
 * Per-event implementation snippets for every platform.
 *
 * All four SDKs (TypeScript / React Native, Kotlin, Swift, Dart) and the REST
 * API are built and tested; none is on a package registry yet, so each SDK tab
 * says to add it from the repository (see sdks.ts).
 */
import { msg } from "@/i18n/translate";
import type { PropertySpec } from "./catalog/properties";
import { sdkNote } from "./sdks";

export type CodeTarget = "kotlin" | "swift" | "react_native" | "flutter" | "backend";

export const SDK_AVAILABILITY: Record<CodeTarget, { label: string; available: boolean; note: string }> = {
  react_native: { label: "React Native / TypeScript", available: true, note: sdkNote("react_native") },
  backend: { label: msg("Backend (REST)"), available: true, note: msg("POST /v1/events with a secret key from your server.") },
  kotlin: { label: "Android (Kotlin)", available: true, note: sdkNote("kotlin") },
  swift: { label: "iOS (Swift)", available: true, note: sdkNote("swift") },
  flutter: { label: "Flutter (Dart)", available: true, note: sdkNote("flutter") },
};

interface SnippetEvent {
  event_name: string;
  source: string;
  properties: Pick<PropertySpec, "name" | "type" | "required" | "example">[];
  source_note?: string | null;
}

function example(p: Pick<PropertySpec, "name" | "type" | "example">, currency: string): unknown {
  if (p.type === "currency") return currency;
  if (p.example !== undefined && p.example !== null) return p.example;
  switch (p.type) {
    case "number": return 0;
    case "integer": return 1;
    case "boolean": return true;
    case "array": return [];
    case "object": return {};
    case "datetime": return "2026-01-01T00:00:00Z";
    default: return `${p.name}_value`;
  }
}

const jsLiteral = (v: unknown) => JSON.stringify(v);
const kotlinLiteral = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : Array.isArray(v) ? `listOf(${v.map(kotlinLiteral).join(", ")})` : String(v));
const swiftLiteral = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(swiftLiteral).join(", ")}]` : String(v));
const dartLiteral = (v: unknown): string => (typeof v === "string" ? `'${v.replace(/'/g, "\\'")}'` : Array.isArray(v) ? `[${v.map(dartLiteral).join(", ")}]` : String(v));

export function generateSnippets(e: SnippetEvent, opts: { currency: string; baseUrl: string }): Record<CodeTarget, string> {
  const props = e.properties.map((p) => [p.name, example(p, opts.currency)] as const);
  const requiredComment = (prefix: string) => {
    const req = e.properties.filter((p) => p.required).map((p) => p.name);
    return req.length ? `${prefix} Required: ${req.join(", ")}\n` : "";
  };

  const ts = `${requiredComment("//")}Analytics.track(${jsLiteral(e.event_name)}, {\n${props.map(([k, v]) => `  ${k}: ${jsLiteral(v)},`).join("\n")}\n});`;
  const kotlin = `${requiredComment("//")}Analytics.track(\n    ${JSON.stringify(e.event_name)},\n    mapOf(\n${props.map(([k, v]) => `        ${JSON.stringify(k)} to ${kotlinLiteral(v)},`).join("\n")}\n    )\n)`;
  const swift = `${requiredComment("//")}Analytics.track(${JSON.stringify(e.event_name)}, properties: [\n${props.map(([k, v]) => `    ${JSON.stringify(k)}: ${swiftLiteral(v)},`).join("\n")}\n])`;
  const dart = `${requiredComment("//")}Analytics.track('${e.event_name}', {\n${props.map(([k, v]) => `  '${k}': ${dartLiteral(v)},`).join("\n")}\n});`;

  const body = JSON.stringify(
    {
      event_name: e.event_name,
      event_id: "<unique id, e.g. the transaction id or a UUID>",
      user_id: "<your user id>",
      timestamp: "<ISO 8601>",
      properties: Object.fromEntries(props),
    },
    null,
    2,
  );
  const backend = `${e.source === "backend" && e.source_note ? `# ${e.source_note}\n` : ""}curl -X POST ${opts.baseUrl}/v1/events \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: <same value on every retry>" \\
  -d '${body.replace(/'/g, "'\\''")}'`;

  return { react_native: ts, kotlin, swift, flutter: dart, backend };
}

/** A copy-paste command that sends one event with a public SDK key: the fastest path to a first event. */
export function testEventCurl(baseUrl: string, publicKey: string): string {
  return `curl -X POST ${baseUrl}/v1/events \\
  -H "Authorization: Bearer ${publicKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"event_name":"app_opened","event_id":"'$(uuidgen 2>/dev/null || date +%s%N)'","anonymous_id":"test-device-1",
       "context":{"platform":"ios","app_version":"1.0.0"}}'`;
}
