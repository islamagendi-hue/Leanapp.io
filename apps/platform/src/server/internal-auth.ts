import "server-only";
import { timingSafeEqual } from "node:crypto";

/** True when the request carries `Authorization: Bearer <one of secrets>` (constant-time compare; unset secrets never match). */
export function bearerMatches(req: Request, ...secrets: (string | undefined)[]): boolean {
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "");
  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const want = Buffer.from(secret);
    if (given.length === want.length && timingSafeEqual(given, want)) ok = true;
  }
  return ok;
}
