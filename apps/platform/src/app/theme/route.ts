import { NextResponse } from "next/server";
import { safeNext } from "@/lib/safe-next";
import { isTheme } from "@/lib/theme";

/** Switches light and dark: /theme?to=dark&next=/somewhere sets the `theme` cookie and goes back. */
export function GET(req: Request) {
  const url = new URL(req.url);
  const to = url.searchParams.get("to");
  const next = safeNext(url.searchParams.get("next")) ?? "/";
  const res = NextResponse.redirect(new URL(next, url), 303);
  if (!isTheme(to) || to === "system") res.cookies.delete("theme");
  else res.cookies.set("theme", to, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: true, secure: url.protocol === "https:" });
  return res;
}
