/**
 * The project environment a member is looking at. Shared by the top-bar selector (client),
 * proxy.ts (remembers `?env=`) and pickEnvironment (server), so it must stay free of server-only imports.
 */
export const ENVIRONMENT_ORDER = ["development", "staging", "production"] as const;
export type EnvironmentName = (typeof ENVIRONMENT_ORDER)[number];

/** Remembers the last environment chosen in this browser; production until one is chosen. */
export const ENV_COOKIE = "la_env";
export const ENV_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
export const DEFAULT_ENVIRONMENT: EnvironmentName = "production";

export const isEnvironmentName = (v: unknown): v is EnvironmentName =>
  typeof v === "string" && (ENVIRONMENT_ORDER as readonly string[]).includes(v);
