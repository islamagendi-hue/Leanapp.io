import { cookies } from "next/headers";

/** Light, dark, or "system" (follow the device). Stored in the `theme` cookie by /theme. */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const isTheme = (v: unknown): v is Theme => typeof v === "string" && (THEMES as readonly string[]).includes(v);

export async function getTheme(): Promise<Theme> {
  const v = (await cookies()).get("theme")?.value;
  return isTheme(v) ? v : "system";
}
