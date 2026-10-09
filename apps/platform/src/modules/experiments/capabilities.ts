/**
 * What experiments do today, stated honestly on the Experiments page (the
 * same pattern as deep link capabilities). Pure and client-safe.
 */
import { msg } from "@/i18n/translate";

export type ExperimentCapabilityStatus = "live" | "beta" | "not_built";

export interface ExperimentCapability {
  key: "assignment" | "js_sdk" | "native_sdks" | "results" | "messages";
  label: string;
  status: ExperimentCapabilityStatus;
  detail: string;
}

export const EXPERIMENT_STATUS_LABELS: Record<ExperimentCapabilityStatus, string> = {
  live: msg("Live"),
  beta: msg("Beta"),
  not_built: msg("Not built"),
};

export const EXPERIMENT_CAPABILITIES: ExperimentCapability[] = [
  {
    key: "assignment",
    label: msg("Variant assignment API"),
    status: "live",
    detail: msg("GET /v1/experiments/assignments with the public key returns each person's variant. The same person always gets the same one."),
  },
  {
    key: "js_sdk",
    label: msg("getVariant in the JavaScript SDK"),
    status: "beta",
    detail: msg("Fetches the variant and sends the exposure event once. The SDK is not on npm yet, so it comes from the repository."),
  },
  {
    key: "native_sdks",
    label: msg("Android, iOS and Flutter SDKs"),
    status: "not_built",
    detail: msg("Call the API from your app, then send an experiment_exposure event with track() when the variant is shown."),
  },
  {
    key: "results",
    label: msg("Results and significance"),
    status: "live",
    detail: msg("Conversion per variant, uplift with a 95% interval, a z-test, and a check that each variant got its share of traffic."),
  },
  {
    key: "messages",
    label: msg("A/B tests of campaign messages"),
    status: "not_built",
    detail: msg("A campaign sends one message to its whole audience. Splitting it into variants with a holdout is not built yet."),
  },
];
