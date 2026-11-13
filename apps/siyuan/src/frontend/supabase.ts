import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SyncRecord } from "../shared/sync.js";
import { syncHash } from "./replication.js";

export interface SyncConfig {
  enabled: boolean;
  url: string;
  key: string;
  email: string;
  intervalSeconds: number;
  userId?: string;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = { enabled: false, url: "", key: "", email: "", intervalSeconds: 60 };

export function isConnectionConfigured(config: SyncConfig): boolean {
  return Boolean(config.url || config.key || config.email);
}

export function normalizeConfig(config: SyncConfig): SyncConfig {
  const url = new URL(config.url.trim());
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Enter the HTTPS Supabase project URL");
  }
  const key = config.key.trim();
  let publishable = /^sb_publishable_[\w-]+$/.test(key);
  if (!publishable) {
    try {
      const parts = key.split(".");
      publishable = parts.length === 3 && JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))).role === "anon";
    } catch { /* Invalid or privileged key. */ }
  }
  if (!publishable) throw new Error("Enter a publishable or legacy anon key");
  const email = config.email.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("Enter your Supabase Auth email");
  if (!Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 15 || config.intervalSeconds > 3600) {
    throw new Error("Sync interval must be between 15 and 3600 seconds");
  }
  return { enabled: config.enabled, url: url.origin, key, email, intervalSeconds: config.intervalSeconds,
    ...(typeof config.userId === "string" ? { userId: config.userId } : {}) };
}

export function supabaseClient(config: SyncConfig, workspaceId?: string) {
  return createClient(config.url, config.key, {
    auth: {
      storageKey: `still-auth-${syncHash(JSON.stringify([workspaceId, config.url, config.email]))}`,
      persistSession: workspaceId !== undefined,
      autoRefreshToken: workspaceId !== undefined,
      detectSessionInUrl: false,
    },
    global: {
      fetch(input, init) {
        const timeout = AbortSignal.timeout(12_000);
        return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
      },
    },
  });
}

export async function authenticate(client: SupabaseClient, config: SyncConfig, password?: string): Promise<string> {
  const result = password ? await client.auth.signInWithPassword({ email: config.email, password }) : await client.auth.getSession();
  const user = result.data.session?.user;
  if (result.error || !user || user.email?.toLowerCase() !== config.email) {
    throw new Error(password ? "Supabase login failed. Check the account and password." : "Sign in again with your Supabase password.");
  }
  return user.id;
}

export function supabaseTransport(client: SupabaseClient) {
  return {
    async pull(after: string, limit: number) {
      const { data, error } = await client.rpc("still_sync_pull", { after_revision: after, batch_size: limit });
      if (error) throw new Error(`Supabase pull failed (${error.code || "network"})`);
      return data as (SyncRecord & { revision: string })[];
    },
    async push(records: SyncRecord[]) {
      const { data, error } = await client.rpc("still_sync_push", { changes: records });
      if (error) throw new Error(`Supabase push failed (${error.code || "network"})`);
      return data as SyncRecord[];
    },
  };
}
