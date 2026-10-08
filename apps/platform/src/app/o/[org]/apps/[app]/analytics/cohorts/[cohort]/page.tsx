import { permanentRedirect } from "next/navigation";

/** Every saved cohort was copied into Audiences with the same id, so its old link opens that audience. */
export default async function CohortPage(props: PageProps<"/o/[org]/apps/[app]/analytics/cohorts/[cohort]">) {
  const { org, app, cohort } = await props.params;
  permanentRedirect(`/o/${org}/apps/${app}/engage/audiences/${encodeURIComponent(cohort)}`);
}
