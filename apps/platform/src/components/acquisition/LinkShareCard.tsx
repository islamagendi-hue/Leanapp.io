import { getT } from "@/i18n/server";
import { qrSvg } from "@/modules/deeplinks/qr";

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim().slice(0, 100) : "");

/** The selected link's share URL, with per-placement overrides from the query string, and its QR code. */
export async function LinkShareCard({ link, url, env, sp }: {
  link: { code: string; name: string; source: string; medium: string | null; campaign: string | null; deep_link_path: string | null };
  /** The link's public URL. */
  url: string;
  env: string;
  sp: Record<string, string | string[] | undefined>;
}) {
  const t = await getT();
  const overrides = { utm_campaign: str(sp.utm_campaign), utm_content: str(sp.utm_content) };
  const u = new URL(url);
  for (const [k, v] of Object.entries(overrides)) if (v) u.searchParams.set(k, v);
  const shareUrl = u.toString();
  const svg = qrSvg(shareUrl, { title: t("QR code for {name}", { name: link.name }) });

  return (
    <section className="card grid gap-6 md:grid-cols-[1fr_220px]" aria-label={t("URL and QR code")}>
      <div className="space-y-3">
        <h2 className="h2">{link.name}</h2>
        <p className="text-sm text-ink-2">{link.source}{link.medium ? ` / ${link.medium}` : ""}{link.campaign ? ` · ${link.campaign}` : ""}{link.deep_link_path ? <> <span aria-hidden className="inline-block rtl:-scale-x-100">→</span> <span dir="ltr">{link.deep_link_path}</span></> : ""}</p>
        <code className="code block break-all" dir="ltr">{shareUrl}</code>
        <form method="get" className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <input type="hidden" name="env" value={env} />
          <input type="hidden" name="link" value={link.code} />
          <label className="block"><span className="label">{t("Campaign (override)")}</span><input name="utm_campaign" className="input" defaultValue={overrides.utm_campaign} placeholder={link.campaign ?? "eid_2026"} /></label>
          <label className="block"><span className="label">{t("Placement / creative")}</span><input name="utm_content" className="input" defaultValue={overrides.utm_content} placeholder="poster_riyadh_park" /></label>
          <button type="submit" className="btn-secondary">{t("Update")}</button>
        </form>
        <p className="help">{t("Overrides are added to the URL (utm_campaign, utm_content) and recorded with each click; source and medium stay the link's.")}</p>
      </div>
      <div className="space-y-2">
        <div className="rounded-lg border border-line bg-white p-2" dangerouslySetInnerHTML={{ __html: svg }} />
        <a className="btn-secondary w-full justify-center" download={`leanapp-${link.code}.svg`} href={`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`}>{t("Download SVG")}</a>
      </div>
    </section>
  );
}
