/**
 * What the media library accepts: types (by signature, see ./signature.ts),
 * sizes, dimensions, and the name, folder and tags people give files. Per
 * channel limits are stricter and live in ./channel-rules.ts. Pure.
 */
import { msg } from "@/i18n/translate";
import { EXTENSION_OF, KIND_OF, MEDIA_MIME_TYPES, imageDimensions, isAnimated, sniffMime, type MediaKind, type MediaMime } from "./signature";

/**
 * Upper bound for one file. 4 MB by default: Vercel functions refuse request
 * bodies over 4.5 MB, and every image limit that matters (WhatsApp 5 MB,
 * FCM 1 MB) is at or under it. Self-hosted deployments may raise it with
 * MEDIA_MAX_UPLOAD_BYTES, capped at 9 MB: the request proxy buffers at most 10 MB of a body.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const HARD_MAX_UPLOAD_BYTES = 9 * 1024 * 1024;
export const MAX_DIMENSION = 8192;
export const MAX_FILES_PER_UPLOAD = 10;
export const MAX_TAGS = 20;

export function maxUploadBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MEDIA_MAX_UPLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), HARD_MAX_UPLOAD_BYTES) : DEFAULT_MAX_UPLOAD_BYTES;
}

export interface CheckedFile {
  mime: MediaMime;
  kind: MediaKind;
  extension: string;
  width: number | null;
  height: number | null;
  animated: boolean;
}

export class MediaValidationError extends Error {}

/** Browsers send these for files they can't type; the bytes decide then. */
const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream"]);
/** Declared aliases that mean the same type. */
const ALIASES: Record<string, MediaMime> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "video/3gpp2": "video/3gpp", "audio/3gpp": "video/3gpp" };

/** Checks one uploaded file; throws MediaValidationError with a message for the person. */
export function checkFile(bytes: Uint8Array, declared: string, maxBytes = maxUploadBytes()): CheckedFile {
  if (bytes.length === 0) throw new MediaValidationError(msg("The file is empty."));
  if (bytes.length > maxBytes) throw new MediaValidationError(msg("The file is larger than the upload limit."));
  const mime = sniffMime(bytes);
  if (!mime) throw new MediaValidationError(msg("This file type isn't supported. Upload JPEG, PNG or WebP images, GIF, MP4 or 3GP video, or PDF."));
  const said = (declared || "").split(";")[0].trim().toLowerCase();
  const claimed = ALIASES[said] ?? said;
  if (!GENERIC.has(claimed) && claimed !== mime) throw new MediaValidationError(msg("The file's contents don't match its type."));
  const kind = KIND_OF[mime];
  let width: number | null = null;
  let height: number | null = null;
  if (kind === "image" || kind === "gif") {
    const d = imageDimensions(bytes, mime);
    if (!d) throw new MediaValidationError(msg("The image header can't be read. The file may be damaged."));
    if (d.width > MAX_DIMENSION || d.height > MAX_DIMENSION) throw new MediaValidationError(msg("The image is larger than 8192 pixels on a side."));
    width = d.width;
    height = d.height;
  }
  return { mime, kind, extension: EXTENSION_OF[mime], width, height, animated: isAnimated(bytes, mime) };
}

export const isMediaMime = (v: unknown): v is MediaMime => typeof v === "string" && (MEDIA_MIME_TYPES as readonly string[]).includes(v);

/** A display name from a file name: no path, no control characters, at most 200 characters. */
export function cleanName(name: string | undefined | null, fallback = "file"): string {
  const base = (name ?? "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || fallback).slice(0, 200);
}

/** A folder path like "campaigns/ramadan": lowercase words separated by "/", or null for none. */
export function cleanFolder(v: string | undefined | null): string | null {
  const parts = (v ?? "").toLowerCase().split("/").map((p) => p.trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "")).filter(Boolean);
  const path = parts.join("/").slice(0, 100);
  return path || null;
}

/** Tags from comma-separated text: trimmed, lowercased, unique, at most 20 of 40 characters. */
export function cleanTags(v: string | string[] | undefined | null): string[] {
  const list = Array.isArray(v) ? v : (v ?? "").split(",");
  const out: string[] = [];
  for (const raw of list) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}
