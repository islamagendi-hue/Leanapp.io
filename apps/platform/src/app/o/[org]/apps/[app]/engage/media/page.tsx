import Link from "next/link";
import { deleteMediaAction, setMediaPublicAction, updateMediaAction } from "@/app/actions/media";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate } from "@/components/engage/shared";
import { MediaReplace, MediaUploader } from "@/components/engage/MediaUploader";
import { fmtBytes } from "@/components/engage/media-upload";
import { getLang, getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { NotFoundError } from "@/lib/errors";
import { MEDIA_CHANNELS, validateMediaForChannel, type MediaChannel } from "@/modules/media/channel-rules";
import { maxUploadBytes } from "@/modules/media/policy";
import { getMedia, listMedia, type MediaAsset } from "@/modules/media/service";
import type { MediaKind } from "@/modules/media/signature";
import { can } from "@/modules/rbac/authorize";
import { mediaFileUrl } from "@/server/media";
import { loadApp, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Media library") };
}

const KINDS: [MediaKind, string][] = [["image", msg("Images")], ["gif", msg("GIFs")], ["video", msg("Videos")], ["document", msg("Documents")]];
const CHANNEL_NAMES: Record<MediaChannel, string> = { push: msg("Push"), web_push: msg("Web push"), in_app: msg("In-app"), email: msg("Email"), whatsapp: "WhatsApp", sms: msg("SMS") };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function MediaLibraryPage(props: PageProps<"/o/[org]/apps/[app]/engage/media">) {
  const { org, app: appSlug } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app } = await loadApp(org, appSlug);
  requirePermission(ctx, "media.read");
  const manage = can(ctx.role, "media.manage");
  const filter = { q: one(sp.q), folder: one(sp.folder), tag: one(sp.tag), kind: KINDS.find(([k]) => k === one(sp.kind))?.[0] };
  const { assets, folders, tags } = await listMedia(ctx, app.id, filter);
  const viewId = one(sp.view);
  let viewing: MediaAsset | null = null;
  if (viewId) {
    try {
      viewing = await getMedia(ctx, app.id, viewId);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const base = `/o/${org}/apps/${appSlug}/engage/media`;
  const href = (p: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: filter.q, folder: filter.folder, tag: filter.tag, kind: filter.kind, ...p })) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };
  const filtered = Boolean(filter.q || filter.folder || filter.tag || filter.kind);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("Media library")}</h1>
        <p className="mt-1 max-w-2xl text-ink-2">{t("Images and files for push, in-app, email and WhatsApp messages in {app}, shared by all its environments. Each message checks the file against its channel's limits.", { app: app.name })}</p>
      </div>

      {manage && <MediaUploader uploadUrl={`${base}/upload`} maxBytes={maxUploadBytes()} folders={folders} />}

      <form className="filters" action={base}>
        <input name="q" className="input max-w-xs" placeholder={t("Search names and tags")} defaultValue={filter.q} aria-label={t("Search")} />
        <select name="kind" className="input max-w-[10rem]" defaultValue={filter.kind ?? ""} aria-label={t("Type")}>
          <option value="">{t("All types")}</option>
          {KINDS.map(([k, label]) => <option key={k} value={k}>{t(label)}</option>)}
        </select>
        <select name="folder" className="input max-w-[12rem]" defaultValue={filter.folder} aria-label={t("Folder")}>
          <option value="">{t("All folders")}</option>
          {folders.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select name="tag" className="input max-w-[10rem]" defaultValue={filter.tag} aria-label={t("Tag")}>
          <option value="">{t("All tags")}</option>
          {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
        <button className="btn btn-secondary">{t("Filter")}</button>
        {filtered && <Link href={base} className="link-action text-sm">{t("Clear")}</Link>}
      </form>

      {viewing && <Details org={org} appSlug={appSlug} asset={viewing} manage={manage} closeHref={href({ view: undefined })} lang={lang} />}

      {assets.length === 0 ? (
        <p className="text-ink-3">{filtered ? t("No files match.") : manage ? t("No files yet. Upload images above.") : t("No files yet.")}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {assets.map((a) => (
            <li key={a.id}>
              <Link href={href({ view: a.id })} className={`card block space-y-2 p-3 ${a.id === viewing?.id ? "ring-2 ring-accent" : ""}`} scroll={false}>
                <Preview org={org} appSlug={appSlug} asset={a} className="h-32" />
                <span className="block truncate text-sm" dir="auto">{a.name}</span>
                <span className="block text-xs text-ink-3">{fmtBytes(a.sizeBytes)}{a.width ? ` · ${a.width}×${a.height}` : ""}{a.folder ? ` · ${a.folder}` : ""}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function Preview({ org, appSlug, asset, className }: { org: string; appSlug: string; asset: MediaAsset; className: string }) {
  const t = await getT();
  const url = mediaFileUrl(org, appSlug, asset.id);
  if (asset.kind === "image" || asset.kind === "gif") {
    // eslint-disable-next-line @next/next/no-img-element -- an authorized same-origin file route
    return <img src={url} alt={asset.name} loading="lazy" className={`${className} w-full rounded bg-paper-2 object-contain`} />;
  }
  if (asset.kind === "video") return <video src={url} className={`${className} w-full rounded bg-paper-2`} preload="metadata" controls={className !== "h-32"} aria-label={asset.name} />;
  return <span className={`${className} flex w-full items-center justify-center rounded bg-paper-2 text-ink-3`}>{t("PDF document")}</span>;
}

async function Details({ org, appSlug, asset, manage, closeHref, lang }: { org: string; appSlug: string; asset: MediaAsset; manage: boolean; closeHref: string; lang: "en" | "ar" }) {
  const t = await getT();
  const fileUrl = mediaFileUrl(org, appSlug, asset.id);
  const facts = { mime: asset.mime, kind: asset.kind, sizeBytes: asset.sizeBytes, width: asset.width, height: asset.height, animated: asset.animated };
  const fits = MEDIA_CHANNELS.map((c) => ({ channel: c, check: validateMediaForChannel(facts, { channel: c }) }));
  return (
    <section className="card space-y-4" aria-label={t("File details")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="h2 break-all" dir="auto">{asset.name}</h2>
        <Link href={closeHref} className="link-action text-sm" scroll={false}>{t("Close")}</Link>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Preview org={org} appSlug={appSlug} asset={asset} className="h-72" />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-3">{t("Type")}</dt><dd dir="ltr">{asset.mime}{asset.animated ? ` (${t("animated")})` : ""}</dd>
          <dt className="text-ink-3">{t("Size")}</dt><dd>{fmtBytes(asset.sizeBytes)}{asset.width ? ` · ${asset.width}×${asset.height}` : ""}</dd>
          <dt className="text-ink-3">{t("Uploaded")}</dt><dd>{fmtDate(asset.createdAt, lang)}{asset.createdByEmail ? ` · ${asset.createdByEmail}` : ""}</dd>
          <dt className="text-ink-3">{t("Used by")}</dt><dd>{asset.usages === 0 ? t("No messages") : t("{n} messages or templates", { n: asset.usages })}</dd>
          <dt className="text-ink-3">{t("Checksum")}</dt><dd className="truncate font-mono text-xs" dir="ltr" title={asset.checksum}>sha256:{asset.checksum.slice(0, 16)}…</dd>
          <dt className="text-ink-3">{t("Public link")}</dt>
          <dd className="break-all">{asset.publicUrl ? <a href={asset.publicUrl} className="link-action" dir="ltr" target="_blank" rel="noopener noreferrer">{asset.publicUrl}</a> : t("Off: only members can open this file.")}</dd>
        </dl>
      </div>

      <div>
        <h3 className="label">{t("Fits these channels")}</h3>
        <ul className="mt-1 flex flex-wrap gap-2 text-xs">
          {fits.map(({ channel, check }) => (
            <li key={channel} className={`pill ${check.ok ? "border-accent/40 text-accent-ink" : "border-line text-ink-3"}`} title={check.ok ? check.warnings.map((w) => t(w.message, w.params)).join(" ") : t(check.errors[0].message, check.errors[0].params)}>
              {t(CHANNEL_NAMES[channel])}: {check.ok ? (check.warnings.length ? t("yes, with notes") : t("yes")) : t("no")}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-ink-3">{t("SMS shows yes only when an SMS provider declares MMS support. WhatsApp also checks the template's approved header type when the file is chosen.")}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <a href={`${fileUrl}?download=1`} className="btn btn-secondary">{t("Download")}</a>
        {manage && <MediaReplace replaceUrl={`/o/${org}/apps/${appSlug}/engage/media/${asset.id}/replace`} accept={asset.kind === "image" ? "image/jpeg,image/png,image/webp" : asset.mime} />}
        {manage && (
          <ActionForm action={setMediaPublicAction.bind(null, org, appSlug, asset.id, !asset.publicAccess)} submitLabel={asset.publicAccess ? t("Turn public link off") : t("Turn public link on")} buttonClass="btn btn-secondary" className=""
            confirm={asset.publicAccess ? undefined : t("Anyone with the link can open this file. Providers such as WhatsApp, push and email need this to fetch it. Continue?")} />
        )}
        {manage && <ActionForm action={deleteMediaAction.bind(null, org, appSlug, asset.id)} submitLabel={t("Delete")} buttonClass="btn btn-danger" className="" confirm={t('Delete "{name}"?', { name: asset.name })} />}
      </div>
      {manage && asset.usages > 0 && <p className="text-xs text-ink-3">{t("Files used by messages or templates can't be deleted until they are removed from them.")}</p>}

      {manage && (
        <details>
          <summary className="cursor-pointer text-sm text-ink-2">{t("Edit name, folder and tags")}</summary>
          <ActionForm action={updateMediaAction.bind(null, org, appSlug, asset.id)} submitLabel={t("Save")} className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="block"><span className="label">{t("Name")}</span><input name="name" className="input" defaultValue={asset.name} maxLength={200} required /></label>
            <label className="block"><span className="label">{t("Folder")}</span><input name="folder" className="input" defaultValue={asset.folder ?? ""} maxLength={100} dir="ltr" /></label>
            <label className="block"><span className="label">{t("Tags, comma-separated")}</span><input name="tags" className="input" defaultValue={asset.tags.join(", ")} maxLength={400} /></label>
          </ActionForm>
        </details>
      )}
      {!manage && asset.tags.length > 0 && <p className="text-sm text-ink-2">{asset.tags.join(", ")}</p>}
    </section>
  );
}
