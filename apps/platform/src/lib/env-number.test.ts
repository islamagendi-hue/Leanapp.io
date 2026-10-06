import { afterEach, describe, expect, it } from "vitest";
import { envNumber } from "./env-number";

afterEach(() => {
  delete process.env.TEST_ENV_NUMBER;
});

describe("envNumber", () => {
  it("falls back when unset, empty or invalid", () => {
    expect(envNumber("TEST_ENV_NUMBER", 7)).toBe(7);
    for (const v of ["", "  ", "abc", "-1"]) {
      process.env.TEST_ENV_NUMBER = v;
      expect(envNumber("TEST_ENV_NUMBER", 7)).toBe(7);
    }
  });

  it("reads numbers, including zero", () => {
    process.env.TEST_ENV_NUMBER = "250";
    expect(envNumber("TEST_ENV_NUMBER", 7)).toBe(250);
    process.env.TEST_ENV_NUMBER = "0";
    expect(envNumber("TEST_ENV_NUMBER", 7)).toBe(0);
  });
});
