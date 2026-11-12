import type { DueReminder } from "@still/core";
import type { StillClient } from "@still/ui";
import type { IKernelPluginRpc } from "siyuan";
import { RPC } from "../shared/rpc.js";

import type { SyncRecord, WorkspaceRecords } from "../shared/sync.js";

export interface SiyuanStillClient extends StillClient {
  syncRecords(): Promise<WorkspaceRecords>;
  applySyncRecords(records: SyncRecord[]): Promise<unknown>;
  pendingReminders(): Promise<DueReminder[]>;
  /** Returns the keys this window won; see the kernel's `claimReminders`. */
  claimReminders(keys: string[]): Promise<string[]>;
}

export class RpcTimeoutError extends Error {
  constructor(method: string) {
    super(`Still kernel did not answer "${method}" in time`);
    this.name = "RpcTimeoutError";
  }
}

/** Generous: the kernel may be busy starting up, syncing or indexing. */
const TIMEOUT_MS = 15_000;

/** StillClient backed by the Still kernel plugin over SiYuan's JSON-RPC bridge. */
export function createRpcClient(rpc: IKernelPluginRpc): SiyuanStillClient {
  const call = <T>(method: string, ...params: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new RpcTimeoutError(method)), TIMEOUT_MS);
      rpc.call[method]!(...(params as never[])).then(
        (value: T) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          window.clearTimeout(timer);
          reject(error);
        },
      );
    });

  return {
    snapshot: () => call(RPC.snapshot),
    syncRecords: () => call(RPC.syncRecords),
    applySyncRecords: (records) => call(RPC.applySyncRecords, records),
    createSubscription: (input) => call(RPC.createSubscription, input),
    updateSubscription: (id, input) => call(RPC.updateSubscription, id, input),
    deleteSubscription: async (id) => {
      await call(RPC.deleteSubscription, id);
    },
    updateSettings: (patch) => call(RPC.updateSettings, patch),
    decide: (subscriptionId, chargeDate, choice, snoozeUntil) => call(RPC.decide, subscriptionId, chargeDate, choice, snoozeUntil),
    undoDecision: (subscriptionId, chargeDate, restore) => call(RPC.undoDecision, subscriptionId, chargeDate, restore),
    exportData: () => call(RPC.exportData),
    importData: (backup) => call(RPC.importData, backup),
    refreshRates: () => call(RPC.refreshRates),
    getNotifications: () => call(RPC.getNotifications),
    saveNotifications: (settings) => call(RPC.saveNotifications, settings),
    testChannel: (channel) => call(RPC.testChannel, channel),
    deviceInfo: () => call(RPC.deviceInfo),
    listNotebooks: () => call(RPC.listNotebooks),
    pendingReminders: () => call(RPC.pendingReminders),
    claimReminders: (keys) => call(RPC.claimReminders, keys),
  };
}
