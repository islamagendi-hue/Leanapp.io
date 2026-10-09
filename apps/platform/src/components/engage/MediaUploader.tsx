"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useT } from "@/i18n/client";
import { msg } from "@/i18n/translate";
import { translateMessage } from "@/modules/automation/messages";
import { fmtBytes, postWithProgress } from "./media-upload";

type Item = { key: string; name: string; size: number; progress: number; state: "uploading" | "done" | "duplicate" | "failed"; error?: string };

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/3gpp,application/pdf";

/** Upload one or more files to the library, each with its own progress and result. */
export function MediaUploader({ uploadUrl, maxBytes, folders }: { uploadUrl: string; maxBytes: number; folders: string[] }) {
  const t = useT();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [folder, setFolder] = useState("");
  const [tags, setTags] = useState("");
  const [dragging, setDragging] = useState(false);
  const busy = items.some((i) => i.state === "uploading");

  const patch = (key: string, p: Partial<Item>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));

  async function upload(files: File[]) {
    if (!files.length) return;
    const batch = files.slice(0, 10).map((f, n) => ({ file: f, item: { key: `${Date.now()}-${n}-${f.name}`, name: f.name, size: f.size, progress: 0, state: "uploading" as const } }));
    setItems((list) => [...batch.map((b) => b.item), ...list].slice(0, 30));
    // One request per file: separate progress, and one failure doesn't stop the rest.
    for (const { file, item } of batch) {
      if (file.size > maxBytes) {
        patch(item.key, { state: "failed", error: t("The file is larger than the upload limit.") });
        continue;
      }
      const form = new FormData();
      form.append("file", file);
      form.append("folder", folder);
      form.append("tags", tags);
      const res = await postWithProgress(uploadUrl, form, (p) => patch(item.key, { progress: p }));
      const result = (res.body?.results as { ok: boolean; duplicate?: boolean; error?: string }[] | undefined)?.[0];
      if (res.status === 200 && result?.ok) patch(item.key, { state: result.duplicate ? "duplicate" : "done", progress: 1 });
      else {
        const message = result?.error ?? (res.body?.message as string | undefined) ?? (res.status === 0 ? msg("The upload failed. Check your connection and try again.") : msg("Something went wrong. Please try again."));
        patch(item.key, { state: "failed", error: translateMessage(t, message) });
      }
    }
    if (input.current) input.current.value = "";
    router.refresh();
  }

  return (
    <section className="card space-y-3">
      <h2 className="h2">{t("Upload")}</h2>
      <div
        className={`rounded-lg border-2 border-dashed p-6 text-center text-sm ${dragging ? "border-accent bg-accent-soft" : "border-line"}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload([...e.dataTransfer.files]);
        }}
      >
        <p className="text-ink-2">{t("Drop files here, or")}</p>
        <label className="btn btn-secondary mt-2 cursor-pointer">
          {t("Choose files")}
          <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" disabled={busy} onChange={(e) => void upload([...(e.target.files ?? [])])} />
        </label>
        <p className="mt-2 text-xs text-ink-3">{t("JPEG, PNG or WebP images; GIF, MP4 or 3GP video and PDF where a channel allows them. Up to {size} each, 10 at a time.", { size: fmtBytes(maxBytes) })}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="label">{t("Folder (optional)")}</span>
          <input className="input" list="media-folders" value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={100} placeholder="campaigns/ramadan" dir="ltr" />
          <datalist id="media-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
        </label>
        <label className="block"><span className="label">{t("Tags, comma-separated (optional)")}</span><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} maxLength={400} /></label>
      </div>
      {items.length > 0 && (
        <ul className="space-y-2 text-sm" aria-live="polite">
          {items.map((i) => (
            <li key={i.key} className="space-y-1">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="truncate" dir="auto">{i.name} <span className="text-ink-3">({fmtBytes(i.size)})</span></span>
                <span className={i.state === "failed" ? "text-alert" : i.state === "uploading" ? "text-ink-3" : "text-accent-ink"}>
                  {i.state === "uploading" ? t("Uploading {percent}%", { percent: Math.round(i.progress * 100) })
                    : i.state === "done" ? t("Uploaded")
                      : i.state === "duplicate" ? t("Already in the library") : t("Failed")}
                </span>
              </div>
              {i.state === "uploading" && (
                <div className="h-1.5 overflow-hidden rounded bg-paper-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(i.progress * 100)}>
                  <div className="h-full bg-accent" style={{ width: `${Math.round(i.progress * 100)}%` }} />
                </div>
              )}
              {i.error && <p className="text-alert" role="alert">{i.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Replace a file's contents, keeping its id and public link. */
export function MediaReplace({ replaceUrl, accept }: { replaceUrl: string; accept: string }) {
  const t = useT();
  const router = useRouter();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function replace(file: File | undefined) {
    if (!file) return;
    if (!window.confirm(t("Replace this file? Messages using it will send the new file."))) return;
    setError(null);
    setDone(false);
    setProgress(0);
    const form = new FormData();
    form.append("file", file);
    const res = await postWithProgress(replaceUrl, form, setProgress);
    setProgress(null);
    if (res.status === 200) {
      setDone(true);
      router.refresh();
    } else setError(translateMessage(t, (res.body?.message as string | undefined) ?? msg("Something went wrong. Please try again.")));
  }

  return (
    <div className="space-y-1">
      <label className="btn btn-secondary cursor-pointer">
        {progress === null ? t("Replace file") : t("Uploading {percent}%", { percent: Math.round(progress * 100) })}
        <input type="file" accept={accept} className="sr-only" disabled={progress !== null} onChange={(e) => void replace(e.target.files?.[0])} />
      </label>
      {done && <p className="text-sm text-accent-ink">{t("Replaced.")}</p>}
      {error && <p className="text-sm text-alert" role="alert">{error}</p>}
    </div>
  );
}
