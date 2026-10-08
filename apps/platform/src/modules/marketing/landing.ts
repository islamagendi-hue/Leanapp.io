/**
 * Landing page content: the product flow and what is live, in beta or coming.
 * Every label must match the product (landing.test.ts guards the claims that
 * were wrong before). Pure.
 */

export type Availability = "live" | "beta" | "coming";

export const AVAILABILITY_LABELS: Record<Availability, string> = { live: "Live", beta: "Beta", coming: "Coming" };

export interface FlowStep {
  step: string;
  title: string;
  body: string;
  items: { name: string; state: Availability; note?: string }[];
}

export const FLOW: FlowStep[] = [
  {
    step: "Connect",
    title: "Connect your app",
    body: "Answer a few questions about your business and get a tracking plan: the events to send, their properties and why each exists. Then add an SDK or call the REST API.",
    items: [
      { name: "Tracking plan from your business model", state: "live" },
      { name: "REST API for servers", state: "live" },
      { name: "JavaScript / React Native, Android, iOS and Flutter SDKs", state: "beta", note: "Built and tested; added from our repository until they are on npm, Maven Central, pub.dev and Swift Package Manager." },
    ],
  },
  {
    step: "Collect",
    title: "Collect clean events",
    body: "Every event is checked against your plan as it arrives. Development, staging and production have their own keys and never mix.",
    items: [
      { name: "Live event debugger and validation", state: "live" },
      { name: "Implementation score", state: "live" },
      { name: "Consent and privacy requests (export, deletion)", state: "live" },
    ],
  },
  {
    step: "Understand",
    title: "Understand what users do",
    body: "Trends, users and revenue on the events you already send, with dashboards you can start from a template.",
    items: [
      { name: "Overview, events and trends, users and their attributes", state: "live" },
      { name: "Revenue and activation", state: "live" },
      { name: "Dashboards and saved reports", state: "live" },
    ],
  },
  {
    step: "Funnels",
    title: "Find where people drop",
    body: "Build a funnel from any events, see conversion and drop-off between steps, split by platform or limited to an audience.",
    items: [{ name: "Funnels", state: "live" }],
  },
  {
    step: "Retention",
    title: "See who comes back",
    body: "Of the people who started on a given day, see how many came back N days later, for everyone or one audience.",
    items: [{ name: "Retention", state: "live" }],
  },
  {
    step: "Audiences",
    title: "Save who matters as an audience",
    body: "Define people by what they did and who they are once, then reuse the audience in reports, users, campaigns and flows.",
    items: [{ name: "Audiences", state: "live" }],
  },
  {
    step: "Act",
    title: "Act on it",
    body: "Send a campaign to an audience, or build a flow that reacts to what people do, with a conversion goal to check it worked.",
    items: [
      { name: "Campaigns and flows with goals", state: "live" },
      { name: "Push, email and WhatsApp", state: "live", note: "Through your own Firebase / APNs, Resend and WhatsApp Business accounts." },
      { name: "In-app messages", state: "beta", note: "Delivered by API; the SDKs don't display them yet." },
      { name: "Acquisition: sources, attribution, tracking links and QR codes", state: "beta", note: "Last-touch attribution from your own event stream. Not a full mobile measurement partner." },
      { name: "Deep links that open your app", state: "beta", note: "After a fresh install (deferred) only through our API for now." },
    ],
  },
];

export const COMING: string[] = [
  "SDKs on public package registries",
  "In-app message display in the SDKs",
  "Deferred deep links in the SDKs",
  "Email delivery, open and click tracking",
];

export const NOT_OFFERED =
  "Not offered: SMS, web push, A/B tests, predictive scores, ad cost import and ROAS, fraud prevention, data warehouse exports and SSO.";
