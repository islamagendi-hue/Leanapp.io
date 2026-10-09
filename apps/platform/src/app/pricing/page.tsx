import { Landing } from "@/components/marketing/Landing";

export const metadata = { title: "Pricing" };

export default function PricingPage(props: PageProps<"/pricing">) {
  return <Landing view="pricing" searchParams={props.searchParams} />;
}
