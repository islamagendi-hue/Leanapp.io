import { Landing } from "@/components/marketing/Landing";

export const metadata = { title: "Features" };

export default function FeaturesPage(props: PageProps<"/features">) {
  return <Landing view="features" searchParams={props.searchParams} />;
}
