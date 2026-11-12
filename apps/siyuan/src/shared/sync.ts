import { decisionId, migrateDecision, migrateSubscription, type Decision, type Subscription } from "@still/core";

export interface SyncRecord {
  id: string;
  version: string;
  payload: Subscription | Decision;
}

export interface WorkspaceRecords {
  workspaceId: string;
  records: SyncRecord[];
}

const ID = /^[0-9A-Za-z_-]{1,128}$/;

export function subscriptionRecord(payload: Subscription): SyncRecord {
  return { id: `subscription:${payload.id}`, version: payload.updatedAt, payload };
}

export function decisionRecord(payload: Decision): SyncRecord {
  return { id: `decision:${payload.id}`, version: payload.updatedAt, payload };
}

export function parseSyncRecord(value: unknown): SyncRecord | null {
  if (!value || typeof value !== "object") return null;
  const { id, version, payload } = value as Partial<SyncRecord>;
  if (typeof id !== "string" || !payload || typeof payload.id !== "string" || !ID.test(payload.id)) return null;
  if (id === `subscription:${payload.id}`) {
    const parsed = migrateSubscription(payload);
    if (parsed && version === parsed.updatedAt) return subscriptionRecord(parsed);
  }
  if (id === `decision:${payload.id}`) {
    const parsed = migrateDecision(payload);
    if (parsed && ID.test(parsed.subscriptionId) && parsed.id === decisionId(parsed.subscriptionId, parsed.chargeDate) && version === parsed.updatedAt) {
      return decisionRecord(parsed);
    }
  }
  return null;
}
