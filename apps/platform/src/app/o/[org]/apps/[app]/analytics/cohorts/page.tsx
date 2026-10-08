import { permanentRedirect } from "next/navigation";
import { param } from "@/components/AnalyticsHeader";

/** Cohorts are audiences now (PR 5): the old list opens Audiences in the same environment. */
export default async function CohortsPage(props: PageProps<"/o/[org]/apps/[app]/analytics/cohorts">) {
  const { org, app } = await props.params;
  const env = param((await props.searchParams).env);
  permanentRedirect(`/o/${org}/apps/${app}/engage/audiences${env ? `?env=${encodeURIComponent(env)}` : ""}`);
}
