import "server-only";
import { after } from "next/server";

/**
 * Runs a monitoring report without delaying the response: after() inside a
 * request (so serverless waits for it), right away outside one (tests, scripts).
 */
export function reportInBackground(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}
