import Link from "next/link";
import { getT } from "@/i18n/server";

export default async function NotFound() {
  const t = await getT();
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="text-center">
        <p className="font-mono text-sm text-ink-3">404</p>
        <h1 className="h1 mt-2">{t("This page doesn't exist, or you don't have access to it.")}</h1>
        <Link href="/" className="btn mt-6">{t("Go home")}</Link>
      </div>
    </div>
  );
}
