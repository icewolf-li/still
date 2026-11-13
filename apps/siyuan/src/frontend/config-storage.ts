import type { Plugin } from "siyuan";
import { DEFAULT_SYNC_CONFIG, isConnectionConfigured, normalizeConfig, type SyncConfig } from "./supabase.js";
import type { SyncConfigStorage } from "./sync-controller.js";

export const SYNC_CONFIG_FILE = "supabase-connection-v1.json";

function bounded<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SiYuan plugin storage timed out")), 10_000);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Only connection parameters cross devices. Passwords and Auth sessions never enter this file. */
export function connectionConfig(value: unknown): SyncConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Supabase connection settings");
  const raw = value as Record<string, unknown>;
  const config: SyncConfig = {
    enabled: raw.enabled === true,
    url: typeof raw.url === "string" ? raw.url : "",
    key: typeof raw.key === "string" ? raw.key : "",
    email: typeof raw.email === "string" ? raw.email : "",
    intervalSeconds: typeof raw.intervalSeconds === "number" ? raw.intervalSeconds : 60,
    ...(typeof raw.userId === "string" ? { userId: raw.userId } : {}),
  };
  return !config.enabled && !config.url && !config.key && !config.email ? { ...DEFAULT_SYNC_CONFIG } : normalizeConfig(config);
}

export function pluginSyncConfig(plugin: Pick<Plugin, "loadData" | "saveData" | "data">, legacy: Storage): SyncConfigStorage {
  async function save(config: SyncConfig) {
    const next = connectionConfig(config);
    if (!isConnectionConfigured(next)) throw new Error("Refusing to replace the shared Supabase settings with an empty configuration");
    const result = await bounded(plugin.saveData(SYNC_CONFIG_FILE, next));
    if (!result || result.code !== 0) throw new Error("SiYuan could not save the Supabase connection settings");
  }
  return {
    async load(workspaceId) {
      // loadData falls back to this cache even if another frontend deleted the file.
      delete plugin.data[SYNC_CONFIG_FILE];
      const stored: unknown = await bounded(plugin.loadData(SYNC_CONFIG_FILE));
      const oldKey = `still-sync-${workspaceId}`;
      if (stored !== "" && stored !== null && stored !== undefined) {
        const config = connectionConfig(stored);
        if (isConnectionConfigured(config)) {
          legacy.removeItem(oldKey);
          return config;
        }
      }
      const raw = legacy.getItem(oldKey);
      if (raw !== null) {
        const config = connectionConfig(JSON.parse(raw));
        if (isConnectionConfigured(config)) {
          await save(config);
          // Do not discard the legacy value until the official write was acknowledged.
          legacy.removeItem(oldKey);
          return config;
        }
        legacy.removeItem(oldKey);
      }
      return { ...DEFAULT_SYNC_CONFIG };
    },
    save,
  };
}
