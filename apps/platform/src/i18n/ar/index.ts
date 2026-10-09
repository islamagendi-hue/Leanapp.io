/**
 * Arabic UI strings, keyed by the English text in the code. One file per area
 * so they can be edited side by side; i18n.test.ts checks that every
 * t("…") and msg("…") in the code has an entry here.
 */
import account from "./account";
import acquisition from "./acquisition";
import analytics from "./analytics";
import common from "./common";
import dashboards from "./dashboards";
import devops from "./devops";
import engage from "./engage";
import experiments from "./experiments";
import flows from "./flows";
import media from "./media";
import integrations from "./integrations";
import project from "./project";
import retention from "./retention";
import support from "./support";

// Later files win; common comes last so the shared glossary is never overridden.
export const AR: Record<string, string> = { ...account, ...acquisition, ...analytics, ...dashboards, ...devops, ...flows, ...integrations, ...engage, ...experiments, ...media, ...project, ...retention, ...support, ...common };
