/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCollector } from "../src/collector";
import { DONYATT_LEVEL_MEASURE, SNOWDON_HILL_RAIN_MEASURE } from "../src/config";
import { JpegError, stripJpegMetadata } from "../src/jpeg";
import { adminReports, getPhoto, postReport, type ReportsEnv } from "../src/reportsApi";
import { PHOTOS } from "../src/rules";
import { STATUS_CACHE_KEY } from "../src/statusService";
import { createTestD1 } from "./d1-sqlite";

const fixturePath = (name: string) => join(import.meta.dirname, "fixtures", name);
const fixture = (name: string) => readFileSync(fixturePath(name), "utf8");
const gpsJpeg = new Uint8Array(readFileSync(fixturePath("photo-with-gps.jpg")));
const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text));

describe("stripJpegMetadata", () => {
  it("removes EXIF (camera, GPS) and comments, keeping a valid image", () => {
    expect(has(gpsJpeg, "Exif")).toBe(true);
    expect(has(gpsJpeg, "LeakyPhone")).toBe(true);
    const out = stripJpegMetadata(gpsJpeg);
    expect(out).toMatchObject({ width: 64, height: 48 });
    expect(out.removedSegments).toBeGreaterThanOrEqual(2);
    for (const leak of ["Exif", "LeakyPhone", "TestCam", "secret comment"]) expect(has(out.bytes, leak)).toBe(false);
    expect([...out.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...out.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(out.bytes.length).toBeLessThan(gpsJpeg.length);
  });

  it("is idempotent", () => {
    const once = stripJpegMetadata(gpsJpeg).bytes;
    expect(stripJpegMetadata(once).bytes).toEqual(once);
  });

  it("rejects things that aren't JPEGs", () => {
    expect(() => stripJpegMetadata(new TextEncoder().encode("<svg onload=alert(1)>"))).toThrow(JpegError);
    expect(() => stripJpegMetadata(gpsJpeg.subarray(0, 40))).toThrow(JpegError);
  });
});

// ---------------------------------------------------------------- API

function fakeKV() {
  const store = new Map<string, string>();
  return {
    get: async (k: string, type?: string) => (store.has(k) ? (type === "json" ? JSON.parse(store.get(k)!) : store.get(k)) : null),
    put: async (k: string, v: string) => void store.set(k, v),
  } as unknown as KVNamespace;
}
function fakeR2() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: async (k: string, v: Uint8Array) => void objects.set(k, v),
    get: async (k: string) => (objects.has(k) ? { body: objects.get(k) } : null),
    delete: async (k: string) => void objects.delete(k),
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}
const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("turnstile")) return Response.json({ success: (init!.body as FormData).get("response") === "good-token-123" });
  if (url.includes(DONYATT_LEVEL_MEASURE)) return new Response(fixture("donyatt-level-readings.json"));
  if (url.includes(SNOWDON_HILL_RAIN_MEASURE)) return new Response(fixture("snowdon-hill-rainfall-readings.json"));
  return new Response(fixture("floods-none-local.json"));
}) as typeof fetch;

const NOW = new Date("2026-09-30T20:20:00Z");
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

async function setup(withBucket = true) {
  const { d1, sqlite } = createTestD1();
  await runCollector(d1, new Date("2026-09-30T20:10:00Z"), fetchFn);
  const r2 = fakeR2();
  const env: ReportsEnv = {
    DB: d1, STATUS: fakeKV(), TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret", ADMIN_TOKEN: "admin-token-xyz",
    PHOTOS: withBucket ? r2.bucket : undefined,
  };
  return { env, sqlite, objects: r2.objects };
}

function postWithPhoto(fields: Record<string, string>, photo: Uint8Array | null = gpsJpeg, ip = "203.0.113.7") {
  const form = new FormData();
  const all = { roadId: "a358-donyatt", kind: "do_not_attempt", token: "good-token-123", deviceId: "device-aaaa-1111", ...fields };
  for (const [k, v] of Object.entries(all)) form.append(k, v);
  if (photo) form.append("photo", new File([photo], "photo.jpg", { type: "image/jpeg" }));
  return new Request("https://donyatt.example/api/reports", { method: "POST", headers: { "cf-connecting-ip": ip }, body: form });
}
const admin = (path: string, method = "GET") =>
  new Request(`https://donyatt.example${path}`, { method, headers: { authorization: "Bearer admin-token-xyz", "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });

describe("photo upload", () => {
  it("stores the photo without metadata and shows it straight away, without extra weight", async () => {
    const { env, sqlite, objects } = await setup();
    const res = await postReport(postWithPhoto({}), env, NOW, fetchFn);
    expect(res.status).toBe(201);
    const body = await res.json<{ photoNote: string; road: { status: string; reports: { recent: { photoId?: number }[] } } }>();
    expect(body.photoNote).toMatch(/shown with your report/);
    const row = sqlite.prepare("SELECT id, has_photo, photo_state, photo_key FROM reports").get() as { id: number; photo_key: string };
    expect(row).toMatchObject({ has_photo: 1, photo_state: "pending" });
    // One "Do not attempt" with an unapproved photo: shown, but still only Caution.
    expect(body.road.status).toBe("caution");
    expect(body.road.reports.recent[0].photoId).toBe(row.id);

    const stored = objects.get(row.photo_key)!;
    expect(has(stored, "Exif")).toBe(false);
    expect(has(stored, "LeakyPhone")).toBe(false);
    expect((await getPhoto(env, row.id, later(1))).status).toBe(200);
  });

  it("an approved photo adds weight, so 'Do not attempt' becomes Avoid", async () => {
    const { env, sqlite } = await setup();
    await postReport(postWithPhoto({}), env, NOW, fetchFn);
    const { id } = sqlite.prepare("SELECT id FROM reports").get() as { id: number };
    const path = `/api/admin/reports/${id}/photo/approve`;
    expect((await adminReports(admin(path, "POST"), env, path, later(2))).status).toBe(200);

    const res = await getPhoto(env, id, later(3));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const status = JSON.parse((await env.DB.prepare("SELECT report FROM status_cache WHERE key = ?").bind(STATUS_CACHE_KEY).first<{ report: string }>())!.report);
    expect(status.roads[0].status).toBe("avoid");
    expect(status.roads[0].reports.recent[0].photoId).toBe(id);
  });

  it("hiding the report takes its photo down", async () => {
    const { env, sqlite } = await setup();
    await postReport(postWithPhoto({}), env, NOW, fetchFn);
    const { id } = sqlite.prepare("SELECT id FROM reports").get() as { id: number };
    const path = `/api/admin/reports/${id}/hide`;
    expect((await adminReports(admin(path, "POST"), env, path, later(1))).status).toBe(200);
    expect((await getPhoto(env, id, later(2))).status).toBe(404);
  });

  it("rejecting deletes the file straight away", async () => {
    const { env, sqlite, objects } = await setup();
    await postReport(postWithPhoto({}), env, NOW, fetchFn);
    const { id } = sqlite.prepare("SELECT id FROM reports").get() as { id: number };
    const path = `/api/admin/reports/${id}/photo/reject`;
    await adminReports(admin(path, "POST"), env, path, later(1));
    expect(objects.size).toBe(0);
    expect(sqlite.prepare("SELECT photo_state, photo_key FROM reports").get()).toEqual({ photo_state: "rejected", photo_key: null });
  });

  it("never serves a photo older than 48 hours", async () => {
    const { env, sqlite } = await setup();
    await postReport(postWithPhoto({}), env, NOW, fetchFn);
    const { id } = sqlite.prepare("SELECT id FROM reports").get() as { id: number };
    expect((await getPhoto(env, id, later(47 * 60))).status).toBe(200);
    expect((await getPhoto(env, id, later(49 * 60))).status).toBe(404);
  });

  it("rejects files that aren't JPEGs, without storing the report", async () => {
    const { env, sqlite } = await setup();
    const res = await postReport(postWithPhoto({}, new TextEncoder().encode("<html>not a photo</html>")), env, NOW, fetchFn);
    expect(res.status).toBe(400);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reports").get()).toEqual({ n: 0 });
  });

  it("rejects photos over the size limit", async () => {
    const { env } = await setup();
    const big = new Uint8Array(PHOTOS.maxBytes + 10);
    big.set(gpsJpeg);
    const res = await postReport(postWithPhoto({}, big), env, NOW, fetchFn);
    expect(res.status).toBe(413);
  });

  it("accepts the report without the photo when photos are off", async () => {
    const { env, sqlite } = await setup(false);
    const res = await postReport(postWithPhoto({}), env, NOW, fetchFn);
    expect(res.status).toBe(201);
    expect((await res.json<{ photoNote: string }>()).photoNote).toMatch(/aren't switched on/);
    expect(sqlite.prepare("SELECT has_photo FROM reports").get()).toEqual({ has_photo: 0 });
  });

  it("pauses photos (not reports) after the daily cap", async () => {
    const { env, sqlite, objects } = await setup();
    const insert = sqlite.prepare("INSERT INTO reports (road_id, kind, created_at, device_hash, ip_hash, has_photo) VALUES ('a358-donyatt', 'clear', ?, 'x', 'y', 1)");
    for (let i = 0; i < PHOTOS.maxPerDay; i++) insert.run(NOW.toISOString());
    const res = await postReport(postWithPhoto({}), env, NOW, fetchFn);
    expect(res.status).toBe(201);
    expect((await res.json<{ photoNote: string }>()).photoNote).toMatch(/paused for today/);
    expect(objects.size).toBe(0);
  });

  it("lets the admin view pending photos, but only with the token", async () => {
    const { env, sqlite } = await setup();
    await postReport(postWithPhoto({}), env, NOW, fetchFn);
    const { id } = sqlite.prepare("SELECT id FROM reports").get() as { id: number };
    const path = `/api/admin/photos/${id}`;
    expect((await adminReports(admin(path), env, path)).status).toBe(200);
    const anon = new Request(`https://donyatt.example${path}`);
    expect((await adminReports(anon, env, path)).status).toBe(401);
  });
});
