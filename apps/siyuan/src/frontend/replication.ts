import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { createRxDatabase, type RxCollection, type RxJsonSchema, type WithDeleted } from "rxdb";
import { replicateRxCollection } from "rxdb/plugins/replication";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { parseSyncRecord, type SyncRecord } from "../shared/sync.js";

const schema: RxJsonSchema<SyncRecord> = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 160 },
    version: { type: "string" },
    payload: { type: "object", additionalProperties: true },
  },
  required: ["id", "version", "payload"],
};

export const SYNC_BATCH_SIZE = 50;

export function syncHash(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

export async function openSyncDatabase(workspaceId: string) {
  const db = await createRxDatabase<{ records: RxCollection<SyncRecord> }>({
    name: `still-${syncHash(workspaceId).slice(0, 32)}`,
    storage: getRxStorageDexie(),
    async hashFunction(value) {
      if (typeof value === "string") return syncHash(value);
      const buffer = value instanceof Blob ? await value.arrayBuffer() : value;
      return bytesToHex(sha256(new Uint8Array(buffer)));
    },
  });
  try {
    await db.addCollections({
      records: {
        schema,
        conflictHandler: {
          isEqual: (a, b) => a.version === b.version,
          resolve: async ({ newDocumentState, realMasterState }) =>
            newDocumentState.version > realMasterState.version ? newDocumentState : realMasterState,
        },
      },
    });
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

/** Domain tombstones stay in the payload so they can also be read by the kernel. */
function decode(value: unknown): WithDeleted<SyncRecord> {
  const record = parseSyncRecord(value);
  if (!record) throw new Error("Invalid record in Supabase Still Sync");
  return { ...record, _deleted: false };
}

interface Transport {
  pull(after: string, limit: number): Promise<(SyncRecord & { revision: string })[]>;
  push(records: SyncRecord[]): Promise<SyncRecord[]>;
}

export function replicateStill(collection: RxCollection<SyncRecord>, identifier: string, remote: Transport) {
  return replicateRxCollection<SyncRecord, { revision: string }>({
    collection,
    replicationIdentifier: identifier,
    live: true,
    retryTime: 10_000,
    pull: {
      batchSize: SYNC_BATCH_SIZE,
      async handler(checkpoint, size) {
        const rows = await remote.pull(checkpoint?.revision ?? "0", size);
        const last = rows.at(-1);
        return { documents: rows.map(decode), checkpoint: last ? { revision: last.revision } : checkpoint };
      },
    },
    push: {
      batchSize: SYNC_BATCH_SIZE,
      async handler(rows) {
        const records = rows.map(({ newDocumentState: { id, version, payload } }) => ({ id, version, payload }));
        return (await remote.push(records)).map(decode);
      },
    },
  });
}

/** Merge kernel and IndexedDB without overwriting a newer concurrent RxDB revision. */
export async function mergeKernelRecords(collection: RxCollection<SyncRecord>, records: SyncRecord[]): Promise<SyncRecord[]> {
  const kernel = new Map(records.map((record) => [record.id, record.version]));
  const cached = new Map((await collection.find().exec()).map((doc) => [doc.id, doc]));
  for (const record of records) {
    const existing = cached.get(record.id);
    if (!existing) {
      try {
        await collection.insert(record);
        continue;
      } catch (error) {
        // A replication pull or another window may have inserted it in the meantime.
        const concurrent = await collection.findOne(record.id).exec();
        if (!concurrent) throw error;
        await concurrent.incrementalModify((current) => current.version < record.version ? record : current);
      }
    } else if (existing.version < record.version) {
      await existing.incrementalModify((current) => current.version < record.version ? record : current);
    }
  }
  return (await collection.find().exec()).flatMap((doc) => {
    const previous = kernel.get(doc.id);
    return !previous || previous < doc.version ? [doc.toJSON() as SyncRecord] : [];
  });
}
