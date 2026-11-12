import "fake-indexeddb/auto";
import { PGlite } from "@electric-sql/pglite";
import * as esbuild from "esbuild";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = fileURLToPath(new URL("../../", import.meta.url));
const migration = new URL("../../../../supabase/migrations/20261112035811_still_rxdb_sync.sql", import.meta.url);
const owner = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const version = (n) => `000000001-${n.toString(36).padStart(4, "0")}-test`;

function subscription(id, n, name, deletedAt = null) {
  return {
    id: `subscription:${id}`,
    version: version(n),
    payload: { id, name, updatedAt: version(n), deletedAt, createdAt: "2026-10-12T00:00:00Z", schemaVersion: 1,
      status: "active", price: { amount: 199, currency: "USD" }, cycle: { unit: "month", every: 1 }, anchorDate: "2026-11-12" },
  };
}

function decision(id, n, deletedAt = null) {
  const chargeDate = "2026-11-12";
  return {
    id: `decision:${id}_${chargeDate}`,
    version: version(n),
    payload: { id: `${id}_${chargeDate}`, subscriptionId: id, chargeDate, choice: "keep", snoozeUntil: null,
      decidedAt: "2026-10-12T00:00:00Z", updatedAt: version(n), deletedAt, schemaVersion: 1 },
  };
}

function transport(db, uid) {
  const query = (sql, args) => db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    return (await tx.query(sql, args)).rows;
  });
  return {
    pull: (after, limit) => query("select * from still_sync_pull($1, $2)", [after, limit]),
    push: (rows) => query("select * from still_sync_push($1::jsonb)", [JSON.stringify(rows)]),
  };
}

function inTime(promise) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for replication")), 6000);
    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

async function settle(replication) {
  replication.reSync();
  await inTime(replication.awaitInSync());
}

test("two persistent RxDB replicas round-trip with the actual Postgres migration", { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(app, "node_modules", "still-test-"));
  const entry = join(dir, "replication.mjs");
  await esbuild.build({ absWorkingDir: app, entryPoints: ["src/frontend/replication.ts"], outfile: entry,
    bundle: true, format: "esm", platform: "node", external: ["rxdb", "@noble/hashes"] });
  const { openSyncDatabase, replicateStill, mergeKernelRecords } = await import(pathToFileURL(entry).href);
  const db = await PGlite.create();
  let a;
  let b;
  t.after(async () => {
    await a?.close();
    await b?.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users (id uuid primary key);
    insert into auth.users values ('${owner}'), ('${other}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated;`);
  await db.exec(await readFile(migration, "utf8"));
  const remote = transport(db, owner);
  const isolated = transport(db, other);
  a = await openSyncDatabase("siyuan-a");
  b = await openSyncDatabase("siyuan-b");

  const first = subscription("same-id", 1, "Offline on A");
  assert.deepEqual(await mergeKernelRecords(a.records, [first, decision("same-id", 2)]), []);
  assert.equal((await remote.pull("0", 1)).length, 0);
  const ra = replicateStill(a.records, "still-test", remote);
  ra.error$.subscribe((error) => console.error(error));
  await settle(ra);
  const rb = replicateStill(b.records, "still-test", remote);
  rb.error$.subscribe((error) => console.error(error));
  await settle(rb);
  assert.equal((await b.records.findOne(first.id).exec()).payload.name, "Offline on A");
  assert.equal((await mergeKernelRecords(b.records, [])).length, 2);
  assert.deepEqual(await isolated.pull("0", 100), []);
  await isolated.push([subscription("same-id", 99, "Different account")]);
  assert.equal((await remote.pull("0", 100)).find((row) => row.id === first.id).payload.name, "Offline on A");
  await assert.rejects(db.transaction(async (tx) => {
    await tx.exec("set local role anon");
    await tx.query("select * from still_sync_pull('0', 1)");
  }), /permission denied/);

  await ra.cancel();
  await rb.cancel();
  const bWins = subscription("same-id", 4, "Newer edit on B");
  await mergeKernelRecords(a.records, [subscription("same-id", 3, "Older edit on A")]);
  await mergeKernelRecords(b.records, [bWins]);
  const rb2 = replicateStill(b.records, "still-test", remote);
  await settle(rb2);
  const ra2 = replicateStill(a.records, "still-test", remote);
  await settle(ra2);
  assert.equal((await a.records.findOne(first.id).exec()).payload.name, "Newer edit on B");
  assert.deepEqual((await mergeKernelRecords(a.records, [first, decision("same-id", 2)])).map((row) => row.version), [bWins.version]);

  const deletedAt = "2026-11-12T00:00:00Z";
  await remote.push([subscription("same-id", 5, bWins.payload.name, deletedAt), decision("same-id", 6, deletedAt)]);
  const bulk = Array.from({ length: 51 }, (_, i) => subscription(`batch-${i}`, 7, `Batch ${i}`));
  await remote.push(bulk);
  await settle(ra2);
  assert.equal((await a.records.find().exec()).length, 53);
  assert.equal((await a.records.findOne(first.id).exec()).payload.deletedAt, deletedAt);
  assert.equal((await a.records.findOne(decision("same-id", 0).id).exec()).payload.deletedAt, deletedAt);
  assert.deepEqual((await remote.push([first])).map((row) => row.version), [version(5)]);

  await a.close();
  a = await openSyncDatabase("siyuan-a");
  assert.equal((await a.records.find().exec()).length, 53);
  const observed = [];
  const ra3 = replicateStill(a.records, "still-test", {
    ...remote,
    pull(after, limit) { observed.push(after); return remote.pull(after, limit); },
  });
  await settle(ra3);
  assert.ok(observed.length > 0 && observed.every((after) => BigInt(after) > 0n));
});
