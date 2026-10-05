/** Lowercase ASCII slug; Arabic or other non-Latin names fall back to a random suffix. */
export function slugify(input: string, maxLength = 40): string {
  const base = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : `${base || "app"}-${Math.random().toString(36).slice(2, 8)}`;
}
