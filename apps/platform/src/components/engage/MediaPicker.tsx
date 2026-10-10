"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/i18n/client";
import { msg } from "@/i18n/translate";
import { translateMessage } from "@/modules/automation/messages";
import type { MediaChannel, MediaIssue } from "@/modules/media/channel-rules";
import { fmtBytes, projectBase } from "./media-upload";

interface PickerItem {
  id: string;
  name: string;
  mime: string;
  kind: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  fileUrl: string;
  errors: MediaIssue[];
  warnings: MediaIssue[];
}

async function fetchPicker(base: string, channel: MediaChannel, query: string, extra: string): Promise<{ items: PickerItem[]; error: string | null }> {
  try {
    const res = await fetch(`${base}/engage/media/picker?channel=${encodeURIComponent(channel)}&q=${encodeURIComponent(query)}${extra}`, { cache: "no-store" });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { items: [], error: body?.message ?? msg("The media library could not be loaded.") };
    return { items: body.items as PickerItem[], error: null };
  } catch {
    return { items: [], error: msg("The media library could not be loaded.") };
  }
}

/**
 * Chooses a file from the app's media library for a message. Submits the
 * asset id in a hidden input named `name`; the server checks it again
 * (same app, not deleted, fits the channel) when the message is saved and
 * when it is sent. Files that don't fit the channel can't be chosen.
 */
export function MediaPicker({ name, channel, defaultValue, label, provider, whatsappHeader, onChange }: {
  name: string;
  channel: MediaChannel;
  defaultValue?: string;
  label?: string;
  /** WhatsApp/SMS: check files against this messaging provider's declared media. */
  provider?: string;
  /** WhatsApp template: the approved header type (IMAGE, VIDEO, DOCUMENT). */
  whatsappHeader?: string;
  onChange?: (assetId: string) => void;
}) {
  const t = useT();
  const base = projectBase(usePathname() ?? "");
  const [value, setValueState] = useState(defaultValue ?? "");
  const setValue = (v: string) => {
    setValueState(v);
    onChange?.(v);
  };
  const extra = `${provider ? `&provider=${encodeURIComponent(provider)}` : ""}${whatsappHeader ? `&header=${encodeURIComponent(whatsappHeader)}` : ""}`;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<PickerItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (query: string) => {
    if (!base) return;
    const r = await fetchPicker(base, channel, query, extra);
    setItems(r.items);
    setError(r.error);
  }, [base, channel, extra]);

  // Show the chosen file (and its checks) on an edit form.
  useEffect(() => {
    if (!base || !value || items !== null) return;
    let live = true;
    fetchPicker(base, channel, "", extra).then((r) => {
      if (!live) return;
      setItems(r.items);
      setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [base, channel, value, items, extra]);

  const tr = (i: MediaIssue) => t(i.message, i.params);
  const selected = items?.find((i) => i.id === value) ?? null;

  return (
    <div className="space-y-2">
      <span className="label">{label ?? t("Image (optional)")}</span>
      <input type="hidden" name={name} value={value} />
      {value ? (
        <div className="flex flex-wrap items-center gap-3">
          {selected ? <Thumb item={selected} /> : <span className="text-sm text-ink-3">{items === null ? t("Loading…") : t("The chosen file is no longer in the library.")}</span>}
          {selected && <span className="text-sm" dir="auto">{selected.name}</span>}
          <button type="button" className="btn btn-secondary" onClick={() => setValue("")}>{t("Remove")}</button>
        </div>
      ) : null}
      {selected?.warnings.map((w) => <p key={w.code} className="text-xs text-warn">{tr(w)}</p>)}
      {selected?.errors.map((w) => <p key={w.code} className="text-xs text-alert">{tr(w)}</p>)}
      {!base ? null : (
        <button type="button" className="btn btn-secondary" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void load(q); }}>
          {open ? t("Close media library") : value ? t("Choose another file") : t("Choose from media library")}
        </button>
      )}
      {open && (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="block grow"><span className="label">{t("Search")}</span>
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void load(q); } }} />
            </label>
            <button type="button" className="btn btn-secondary" onClick={() => void load(q)}>{t("Search")}</button>
            <a className="link-action text-sm" href={`${base}/engage/media`} target="_blank" rel="noopener">{t("Upload in the media library")}</a>
          </div>
          {error && <p className="text-sm text-alert" role="alert">{translateMessage(t, error)}</p>}
          {items === null ? <p className="text-sm text-ink-3">{t("Loading…")}</p> : items.length === 0 ? (
            <p className="text-sm text-ink-3">{t("No files yet. Upload them in the media library, then search again.")}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {items.map((i) => {
                const blocked = i.errors.length > 0;
                return (
                  <li key={i.id}>
                    <button
                      type="button"
                      disabled={blocked}
                      title={blocked ? tr(i.errors[0]) : i.name}
                      className={`w-full space-y-1 rounded-lg border p-2 text-start text-xs ${i.id === value ? "border-accent" : "border-line"} ${blocked ? "cursor-not-allowed opacity-50" : "hover:border-line-strong"}`}
                      onClick={() => { setValue(i.id); setOpen(false); }}
                    >
                      <Thumb item={i} />
                      <span className="block truncate" dir="auto">{i.name}</span>
                      <span className="block text-ink-3">{fmtBytes(i.sizeBytes)}{i.width ? ` · ${i.width}×${i.height}` : ""}</span>
                      {blocked && <span className="block text-alert">{tr(i.errors[0])}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function Thumb({ item }: { item: Pick<PickerItem, "kind" | "fileUrl" | "name" | "mime"> }) {
  const t = useT();
  if (item.kind === "image" || item.kind === "gif") {
    // eslint-disable-next-line @next/next/no-img-element -- an authorized same-origin file route, not a static asset
    return <img src={item.fileUrl} alt={item.name} className="h-20 w-full rounded bg-paper-2 object-contain" loading="lazy" />;
  }
  return <span className="flex h-20 w-full items-center justify-center rounded bg-paper-2 text-ink-3">{item.mime === "application/pdf" ? "PDF" : t("Video")}</span>;
}
