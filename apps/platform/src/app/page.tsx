import { Landing } from "@/components/marketing/Landing";

export const metadata = {
  title: { absolute: "LeanApp: product analytics for mobile apps in the Arab world · لين آب" },
  description: "Know your users. Grow your app. Analytics, funnels, retention and campaigns for mobile apps, in Arabic and English.",
};

export default function Home(props: PageProps<"/">) {
  return <Landing view="home" searchParams={props.searchParams} />;
}
