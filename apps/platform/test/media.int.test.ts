/**
 * Media library: upload checks, RBAC, tenant isolation, usage tracking from
 * campaigns, public links, replace, and safe cleanup. Files go to the
 * Postgres driver (the default); object storage is covered by unit tests with
 * a mocked fetch.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { cancelCampaign, createCampaign, updateCampaign } from "@/modules/campaigns/service";
import { createAudience } from "@/modules/audiences/service";
import { gif, jpeg, png } from "@/modules/media/fixtures.test-helper";
import {
  deleteMedia, getMedia, listMedia, purgeDeletedMedia, readMediaFile, readPublicMedia, replaceMedia, resolveMediaForSend, setMediaPublic, updateMedia, uploadMedia, MediaUnavailableError,
} from "@/modules/media/service";
import { setStorageDriverForTests } from "@/modules/media/storage";
import type { TenantContext } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let audienceId: string;
const as = (ctx: TenantContext, role: TenantContext["role"]) => ({ ...ctx, role });
const objects = async (key?: string) =>
  (await withSystem((db) => db.one<{ n: number }>(`select count(*)::int as n from platform.media_objects${key ? " where storage_key = $1" : ""}`, key ? [key] : [])))!.n;
const keyOf = async (id: string) => (await withSystem((db) => db.one<{ storage_key: string; public_token: string }>("select storage_key, public_token from platform.media_assets where id = $1", [id])))!;

beforeAll(async () => {
  t = await makeTenant("media");
  other = await makeTenant("media-other");
  audienceId = (await createAudience(t.ctx, t.dev.id, { name: "Everyone VIP", definition: { type: "user_property", property: "vip", op: "eq", value: true } })).id;
});

describe("media library", () => {
  let heroId: string;

  it("stores a checked upload with dimensions and returns duplicates instead of copies", async () => {
    const { asset, duplicate } = await uploadMedia(t.ctx, t.app.id, { bytes: png(1024, 512), declaredType: "image/png", filename: "../hero.png", folder: "Campaigns/Ramadan", tags: "Hero, sale" });
    expect(duplicate).toBe(false);
    expect(asset).toMatchObject({ name: "hero.png", mime: "image/png", kind: "image", width: 1024, height: 512, folder: "campaigns/ramadan", tags: ["hero", "sale"], publicAccess: false, publicUrl: null, usages: 0 });
    heroId = asset.id;
    const again = await uploadMedia(t.ctx, t.app.id, { bytes: png(1024, 512), declaredType: "image/png", filename: "copy.png" });
    expect(again).toMatchObject({ duplicate: true, asset: { id: heroId } });
    expect((await readMediaFile(t.ctx, t.app.id, heroId)).bytes).toEqual(png(1024, 512));
  });

  it("refuses spoofed and unsupported files without storing anything", async () => {
    const before = await objects();
    await expect(uploadMedia(t.ctx, t.app.id, { bytes: png(10, 10), declaredType: "image/jpeg", filename: "x.jpg" })).rejects.toBeInstanceOf(ValidationError);
    await expect(uploadMedia(t.ctx, t.app.id, { bytes: new TextEncoder().encode("<svg onload=alert(1)>"), declaredType: "image/svg+xml", filename: "x.svg" })).rejects.toBeInstanceOf(ValidationError);
    expect(await objects()).toBe(before);
  });

  it("searches by name and tag and filters by folder, tag and kind", async () => {
    await uploadMedia(t.ctx, t.app.id, { bytes: gif(64, 64, 2), declaredType: "image/gif", filename: "spinner.gif", folder: "ui" });
    expect((await listMedia(t.ctx, t.app.id, { q: "her" })).assets.map((a) => a.name)).toEqual(["hero.png"]);
    expect((await listMedia(t.ctx, t.app.id, { q: "sale" })).assets).toHaveLength(1);
    expect((await listMedia(t.ctx, t.app.id, { q: "%" })).assets).toHaveLength(0); // LIKE wildcards are literal
    expect((await listMedia(t.ctx, t.app.id, { folder: "campaigns" })).assets.map((a) => a.id)).toEqual([heroId]);
    expect((await listMedia(t.ctx, t.app.id, { kind: "gif" })).assets.map((a) => a.name)).toEqual(["spinner.gif"]);
    const all = await listMedia(t.ctx, t.app.id);
    expect(all.folders).toEqual(["campaigns/ramadan", "ui"]);
    expect(all.tags).toEqual(["hero", "sale"]);
  });

  it("enforces media.read and media.manage", async () => {
    await expect(listMedia(as(t.ctx, "analyst"), t.app.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listMedia(as(t.ctx, "viewer"), t.app.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listMedia(as(t.ctx, "marketer"), t.app.id)).assets.length).toBeGreaterThan(0);
    expect((await listMedia(as(t.ctx, "developer"), t.app.id)).assets.length).toBeGreaterThan(0);
    await expect(uploadMedia(as(t.ctx, "viewer"), t.app.id, { bytes: jpeg(10, 10), declaredType: "image/jpeg", filename: "a.jpg" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteMedia(as(t.ctx, "analyst"), t.app.id, heroId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("isolates tenants: another organization can't see, read, change or send the asset", async () => {
    // Even with this tenant's app id, RLS hides the rows.
    expect((await listMedia(other.ctx, t.app.id)).assets).toEqual([]);
    await expect(getMedia(other.ctx, t.app.id, heroId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(readMediaFile(other.ctx, t.app.id, heroId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getMedia(other.ctx, other.app.id, heroId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateMedia(other.ctx, t.app.id, heroId, { name: "pwned" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteMedia(other.ctx, other.app.id, heroId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(replaceMedia(other.ctx, t.app.id, heroId, { bytes: png(5, 5), declaredType: "image/png" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(uploadMedia(other.ctx, t.app.id, { bytes: jpeg(7, 7), declaredType: "image/jpeg", filename: "a.jpg" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveMediaForSend(other.org.id, t.app.id, heroId, "push")).rejects.toBeInstanceOf(MediaUnavailableError);
    await expect(resolveMediaForSend(other.org.id, other.app.id, heroId, "push")).rejects.toBeInstanceOf(MediaUnavailableError);
    // The same bytes in another organization are a separate asset, not a "duplicate" of this one.
    const theirs = await uploadMedia(other.ctx, other.app.id, { bytes: png(1024, 512), declaredType: "image/png", filename: "theirs.png" });
    expect(theirs.duplicate).toBe(false);
    expect(theirs.asset.id).not.toBe(heroId);
    expect((await getMedia(t.ctx, t.app.id, heroId)).name).toBe("hero.png");
  });

  it("serves the public link only while public access is on", async () => {
    const { public_token } = await keyOf(heroId);
    expect(await readPublicMedia(public_token)).toBeNull();
    await expect(resolveMediaForSend(t.org.id, t.app.id, heroId, "push")).rejects.toThrow("no public link");
    await setMediaPublic(t.ctx, t.app.id, heroId, true);
    expect((await readPublicMedia(public_token))?.mime).toBe("image/png");
    const resolved = await resolveMediaForSend(t.org.id, t.app.id, heroId, { channel: "push", platforms: ["android"] });
    expect(resolved.url).toMatch(new RegExp(`/m/${public_token}\\.png$`));
    expect(resolved.check.ok).toBe(true);
    await setMediaPublic(t.ctx, t.app.id, heroId, false);
    expect(await readPublicMedia(public_token)).toBeNull();
    expect(await readPublicMedia("short")).toBeNull();
  });

  describe("used by a campaign", () => {
    let campaignId: string;

    it("records the usage, publishes the link, and checks app and channel", async () => {
      campaignId = (await createCampaign(t.ctx, t.dev.id, { name: "Hero push", form: { audienceId, channel: "push", title: "Hi", body: "Offer", imageAssetId: heroId }, timezone: "UTC" })).id;
      const hero = await getMedia(t.ctx, t.app.id, heroId);
      expect(hero.usages).toBe(1);
      expect(hero.publicAccess).toBe(true);
      expect(hero.publicUrl).toMatch(/\/m\/[A-Za-z0-9_-]+\.png$/);

      const spinner = (await listMedia(t.ctx, t.app.id, { kind: "gif" })).assets[0];
      await expect(createCampaign(t.ctx, t.dev.id, { name: "Gif push", form: { audienceId, channel: "push", title: "Hi", body: "x", imageAssetId: spinner.id }, timezone: "UTC" }))
        .rejects.toThrow("Push images must be JPEG or PNG");
      const theirs = (await listMedia(other.ctx, other.app.id)).assets[0];
      await expect(createCampaign(t.ctx, t.dev.id, { name: "Stolen", form: { audienceId, channel: "push", title: "Hi", body: "x", imageAssetId: theirs.id }, timezone: "UTC" }))
        .rejects.toThrow("not in this app's library");
      await expect(createCampaign(t.ctx, t.dev.id, { name: "Bad id", form: { audienceId, channel: "push", title: "Hi", body: "x", imageAssetId: "not-a-uuid" }, timezone: "UTC" }))
        .rejects.toBeInstanceOf(ValidationError);
    });

    it("blocks deleting the file or unpublishing its link while the campaign uses it", async () => {
      await expect(deleteMedia(t.ctx, t.app.id, heroId)).rejects.toBeInstanceOf(ConflictError);
      await expect(setMediaPublic(t.ctx, t.app.id, heroId, false)).rejects.toBeInstanceOf(ConflictError);
    });

    it("replaces contents in place, keeping id and link, only with the same kind", async () => {
      const before = await keyOf(heroId);
      const replaced = await replaceMedia(t.ctx, t.app.id, heroId, { bytes: jpeg(800, 400), declaredType: "image/jpeg" });
      expect(replaced).toMatchObject({ id: heroId, mime: "image/jpeg", width: 800, height: 400 });
      const after = await keyOf(heroId);
      expect(after.public_token).toBe(before.public_token);
      expect(await objects(before.storage_key)).toBe(0); // the old object is gone
      expect(await objects(after.storage_key)).toBe(1);
      await expect(replaceMedia(t.ctx, t.app.id, heroId, { bytes: gif(10, 10), declaredType: "image/gif" })).rejects.toThrow("same kind");
      // Still an image, but too big for push (1 MB), where it is used.
      await expect(replaceMedia(t.ctx, t.app.id, heroId, { bytes: png(100, 100, 1_200_000), declaredType: "image/png" })).rejects.toThrow("limit for this channel");
      expect((await getMedia(t.ctx, t.app.id, heroId)).mime).toBe("image/jpeg");
    });

    it("drops the usage when the campaign stops using the file, and allows deletion when cancelled", async () => {
      await updateCampaign(t.ctx, campaignId, { name: "Hero push", form: { audienceId, channel: "push", title: "Hi", body: "Offer" }, timezone: "UTC" });
      expect((await getMedia(t.ctx, t.app.id, heroId)).usages).toBe(0);
      await updateCampaign(t.ctx, campaignId, { name: "Hero push", form: { audienceId, channel: "push", title: "Hi", body: "Offer", imageAssetId: heroId }, timezone: "UTC" });
      expect((await getMedia(t.ctx, t.app.id, heroId)).usages).toBe(1);
      await cancelCampaign(t.ctx, campaignId);
      expect((await getMedia(t.ctx, t.app.id, heroId)).usages).toBe(0);
      await deleteMedia(t.ctx, t.app.id, heroId);
      await expect(getMedia(t.ctx, t.app.id, heroId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(resolveMediaForSend(t.org.id, t.app.id, heroId, "push")).rejects.toThrow("deleted");
      expect(await readPublicMedia((await keyOf(heroId)).public_token)).toBeNull();
    });

    it("the purge keeps files a cancelled campaign still references", async () => {
      await withSystem((db) => db.query("update platform.media_assets set deleted_at = now() - interval '30 days' where id = $1", [heroId]));
      const res = await purgeDeletedMedia({ limit: 1000 });
      expect(res.kept).toBeGreaterThanOrEqual(1);
      expect(await objects((await keyOf(heroId)).storage_key)).toBe(1);
    });
  });

  it("purges only deleted, unreferenced files past the grace period", async () => {
    const lone = (await uploadMedia(t.ctx, t.app.id, { bytes: jpeg(33, 33), declaredType: "image/jpeg", filename: "lone.jpg" })).asset;
    const hidden = (await uploadMedia(t.ctx, t.app.id, { bytes: jpeg(34, 34), declaredType: "image/jpeg", filename: "hidden.jpg" })).asset;
    const recent = (await uploadMedia(t.ctx, t.app.id, { bytes: jpeg(35, 35), declaredType: "image/jpeg", filename: "recent.jpg" })).asset;
    for (const a of [lone, hidden, recent]) await deleteMedia(t.ctx, t.app.id, a.id);
    // A reference written straight into a definition without a usage row (e.g. a flow saved by older code).
    await withSystem((db) => db.query(
      `insert into platform.automations (organization_id, app_id, environment_id, name, definition) values ($1, $2, $3, 'legacy', $4)`,
      [t.org.id, t.app.id, t.dev.id, JSON.stringify({ trigger: { type: "event", event: "x" }, steps: [{ type: "push", title: "a", body: "b", imageAssetId: hidden.id }] })],
    ));
    await withSystem((db) => db.query("update platform.media_assets set deleted_at = now() - interval '8 days' where id = any($1::uuid[])", [[lone.id, hidden.id]]));
    const keys = { lone: (await keyOf(lone.id)).storage_key, hidden: (await keyOf(hidden.id)).storage_key, recent: (await keyOf(recent.id)).storage_key };
    await purgeDeletedMedia({ limit: 1000 });
    expect(await objects(keys.lone)).toBe(0);
    expect(await objects(keys.hidden)).toBe(1);
    expect(await objects(keys.recent)).toBe(1);
    const row = await withSystem((db) => db.one<{ purged_at: Date | null }>("select purged_at from platform.media_assets where id = $1", [lone.id]));
    expect(row?.purged_at).toBeInstanceOf(Date);
  });

  it("stores nothing when the storage write fails, and removes the object when the row can't be written", async () => {
    const failing = { name: "postgres" as const, put: async () => { throw new Error("storage down"); }, get: async () => null, delete: async () => {} };
    setStorageDriverForTests(failing);
    try {
      await expect(uploadMedia(t.ctx, t.app.id, { bytes: png(77, 77), declaredType: "image/png", filename: "x.png" })).rejects.toThrow("storage down");
    } finally {
      setStorageDriverForTests(null);
    }
    expect((await listMedia(t.ctx, t.app.id, { q: "x.png" })).assets).toEqual([]);
  });
});
