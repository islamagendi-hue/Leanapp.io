import { describe, expect, it } from "vitest";
import { resolveLocale } from "./locale";

describe("resolveLocale", () => {
  it("defaults to English, left to right", () => {
    expect(resolveLocale(undefined)).toEqual({ lang: "en", dir: "ltr" });
    expect(resolveLocale("fr")).toEqual({ lang: "en", dir: "ltr" });
  });
  it("switches Arabic to right to left", () => {
    expect(resolveLocale("ar")).toEqual({ lang: "ar", dir: "rtl" });
    expect(resolveLocale("ar-SA")).toEqual({ lang: "ar", dir: "rtl" });
  });
});
