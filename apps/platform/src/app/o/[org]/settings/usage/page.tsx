import { redirect } from "next/navigation";

/** Plan & usage moved into Plan & billing; old links keep working. */
export default async function UsagePage(props: PageProps<"/o/[org]/settings/usage">) {
  const { org } = await props.params;
  redirect(`/o/${org}/settings/billing`);
}
