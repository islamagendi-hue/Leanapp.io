import { NextResponse } from "next/server";
import { safeNext } from "@/lib/safe-next";

/** Switches the UI language: /lang?to=ar&next=/somewhere sets the `locale` cookie and goes back. */
export function GET(req: Request) {
  const url = new URL(req.url);
  const to = url.searchParams.get("to") === "en" ? "en" : "ar";
  const next = safeNext(url.searchParams.get("next")) ?? "/";
  const res = NextResponse.redirect(new URL(next, url), 303);
  res.cookies.set("locale", to, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: true, secure: url.protocol === "https:" });
  return res;
}
