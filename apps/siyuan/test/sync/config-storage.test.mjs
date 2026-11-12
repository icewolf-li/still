import * as esbuild from "esbuild";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = await mkdtemp(new URL("../../node_modules/config-test-", import.meta.url));
const root = new URL("../../", import.meta.url);
const file = (name) => fileURLToPath(new URL(name, root));
await esbuild.build({ entryPoints: [file("src/frontend/config-storage.ts")], outfile: join(dir, "config.mjs"), bundle: true, platform: "node", format: "esm", external: ["rxdb", "rxdb/*", "@noble/hashes/*", "@supabase/supabase-js"] });
await esbuild.build({ entryPoints: [file("src/kernel/storage.ts")], outfile: join(dir, "storage.mjs"), bundle: true, platform: "node", format: "esm" });
const { pluginSyncConfig, connectionConfig, SYNC_CONFIG_FILE } = await import(pathToFileURL(join(dir, "config.mjs")));
const { openWorkspace } = await import(pathToFileURL(join(dir, "storage.mjs")));
const config = { enabled: true, url: "https://example.supabase.co", key: "sb_publishable_test", email: "a@example.com", intervalSeconds: 60, userId: "user" };
function setup(stored, old) {
  const disk = new Map(stored ? [[SYNC_CONFIG_FILE, stored]] : []);
  const local = new Map(old ? [["still-sync-device", JSON.stringify(old)]] : []);
  const plugin = { data: { [SYNC_CONFIG_FILE]: { stale: true } }, async loadData(name) { return disk.get(name) ?? this.data[name] ?? ""; }, async saveData(name, value) { disk.set(name, value); return { code: 0 }; } };
  const legacy = { getItem: (k) => local.get(k) ?? null, removeItem: (k) => local.delete(k) };
  return { disk, local, plugin, store: pluginSyncConfig(plugin, legacy) };
}
test("connection migration whitelists fields and deletes old config only after success", async () => {
  const a = setup(null, { ...config, password: "secret", refresh_token: "token" });
  assert.deepEqual(await a.store.load("device"), config); assert.deepEqual(a.disk.get(SYNC_CONFIG_FILE), config); assert.equal(a.local.size, 0); assert.deepEqual(connectionConfig({ ...config, password: "secret" }), config);
});
test("synced config wins over local legacy and reload bypasses SDK fallback cache", async () => {
  const a = setup(config, { ...config, email: "old@example.com" }); assert.deepEqual(await a.store.load("device"), config); a.disk.set(SYNC_CONFIG_FILE, { ...config, enabled: false }); assert.equal((await a.store.load("device")).enabled, false); assert.equal(a.local.size, 0);
});
test("failed save keeps migration source; malformed and privileged settings reject", async () => {
  const a = setup(null, config); a.plugin.saveData = async () => ({ code: -1 }); await assert.rejects(a.store.load("device"), /could not save/); assert.equal(a.local.size, 1); assert.throws(() => connectionConfig({ ...config, key: "sb_secret_privileged" }), /publishable/); a.local.set("still-sync-device", "bad json"); await assert.rejects(a.store.load("device"));
});
function kernel(files = {}) { const disk = new Map(Object.entries(files)); globalThis.siyuan = { client: { async fetch(endpoint, init) { if (endpoint === "/api/file/getFile") { const path = JSON.parse(init.body).path; return disk.has(path) ? { status: 200, text: async () => disk.get(path) } : { status: 202, json: async () => ({ code: 404 }) }; } if (endpoint === "/api/file/putFile") { const boundary = init.headers["Content-Type"].split("boundary=")[1]; const parts = init.body.split(`--${boundary}`); disk.set(parts[1].split("\r\n\r\n")[1].trim(), parts[2].split("\r\n\r\n")[1].trim()); return { ok: true, json: async () => ({ code: 0 }) }; } return { ok: true, status: 200, json: async () => ({ code: 404 }) }; } } }; return disk; }
const localPath = "/conf/still/records-v1.json"; const settingsPath = "/data/storage/petal/still/settings-v2.json";
test("kernel migrates settings only, keeps ID and records, and reads synced changes without restart", async () => { const disk = kernel({ [localPath]: JSON.stringify({ id: "device", files: { "settings.json": '{"notifyAt":"08:00"}', "notifications.json": '{"channels":[]}', "subscriptions/a.json": '{"id":"a"}' } }) }); const { id, files } = await openWorkspace(); assert.equal(id, "device"); assert.ok(JSON.parse(disk.get("/conf/still/before-settings-migration-v2.json")).files["settings.json"]); assert.equal(await files.read("settings.json"), '{"notifyAt":"08:00"}'); assert.equal(JSON.parse(disk.get(localPath)).files["settings.json"], undefined); assert.equal(await files.read("subscriptions/a.json"), '{"id":"a"}'); disk.set(settingsPath, '{"notifyAt":"09:00"}'); assert.equal(await files.read("settings.json"), '{"notifyAt":"09:00"}'); await files.write("settings.json", '{"notifyAt":"10:00"}'); await files.write("subscriptions/b.json", '{"id":"b"}'); assert.equal(disk.get(settingsPath), '{"notifyAt":"10:00"}'); assert.equal(JSON.parse(disk.get(localPath)).files["settings.json"], undefined); });
test("existing official settings win migration; restart does not resurrect removed settings", async () => { const disk = kernel({ [localPath]: JSON.stringify({ id: "device", files: { "settings.json": '{"old":true}' } }), [settingsPath]: '{"synced":true}' }); await openWorkspace(); assert.equal(disk.get(settingsPath), '{"synced":true}'); disk.delete(settingsPath); const { files } = await openWorkspace(); assert.equal(await files.read("settings.json"), null); });




test("fresh workspace migrates pre-RxDB preferences without copying them back into records", async () => {
  const disk = kernel({ "/data/storage/petal/still/settings.json": '{"notifyAt":"07:00"}' });
  const { files } = await openWorkspace();
  assert.equal(await files.read("settings.json"), '{"notifyAt":"07:00"}');
  assert.equal(disk.get("/data/storage/petal/still/settings.json"), '{"notifyAt":"07:00"}');
  assert.equal(JSON.parse(disk.get(localPath)).files["settings.json"], undefined);
});

test.after(async () => { await rm(dir, { recursive: true, force: true }); });
