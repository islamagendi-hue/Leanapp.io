import { Landing } from "@/components/marketing/Landing";

export const metadata = { title: "About us" };

export default function AboutPage(props: PageProps<"/about">) {
  return <Landing view="about" searchParams={props.searchParams} />;
}
