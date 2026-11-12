import type { SupabaseClient } from "@supabase/supabase-js";
import type { SiyuanStillClient } from "./client.js";
import { mergeKernelRecords, openSyncDatabase, replicateStill, SYNC_BATCH_SIZE, syncHash } from "./replication.js";
import { authenticate, DEFAULT_SYNC_CONFIG, normalizeConfig, supabaseClient, supabaseTransport, type SyncConfig } from "./supabase.js";

export interface SyncConfigStorage {
  load(workspaceId: string): Promise<SyncConfig>;
  save(config: SyncConfig): Promise<void>;
}

interface SyncState {
  config: SyncConfig;
  phase: "loading" | "disabled" | "connecting" | "ready" | "error";
  error?: string;
}

export class StillSync {
  #state: SyncState = { config: DEFAULT_SYNC_CONFIG, phase: "loading" };
  #listeners = new Set<() => void>();
  #workspaceId = "";
  #storageKey = "";
  #database?: Awaited<ReturnType<typeof openSyncDatabase>>;
  #changes?: { unsubscribe(): void };
  #remote?: SupabaseClient;
  #replication?: ReturnType<typeof replicateStill>;
  #timer?: number;
  #loading?: Promise<void>;
  #reconciling?: Promise<void>;
  #connecting?: Promise<void>;
  #configureTail: Promise<unknown> = Promise.resolve();
  #dirty = false;
  #closed = false;

  constructor(private readonly kernel: Pick<SiyuanStillClient, "syncRecords" | "applySyncRecords">,
    private readonly configStorage: SyncConfigStorage) {
    window.addEventListener("storage", this.#onStorage);
    window.addEventListener("online", this.request);
  }

  readonly getState = () => this.#state;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #set(patch: Partial<SyncState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #fail(error: unknown) {
    if (!this.#closed) this.#set({ phase: "error", error: error instanceof Error ? error.message : "Still Sync failed" });
  }

  #load(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return this.#loading ??= (async () => {
      const { workspaceId } = await this.kernel.syncRecords();
      const db = await openSyncDatabase(workspaceId);
      if (this.#closed) {
        await db.close();
        return;
      }
      this.#database = db;
      this.#workspaceId = workspaceId;
      this.#storageKey = `still-sync-${workspaceId}`;
      this.#changes = db.records.$.subscribe(this.kernelChanged);
      await this.#applyConfig(await this.configStorage.load(workspaceId));
    })().catch(async (error: unknown) => {
      this.#changes?.unsubscribe();
      await this.#database?.close();
      this.#database = undefined;
      this.#loading = undefined;
      throw error;
    });
  }

  async reloadConfig() {
    await this.#load();
    if (this.#closed) return;
    const config = await this.configStorage.load(this.#workspaceId);
    if (JSON.stringify(config) !== JSON.stringify(this.#state.config)) await this.#applyConfig(config);
    this.request();
  }

  #applyConfig(config: SyncConfig): Promise<void> {
    const apply = this.#configureTail.then(async () => {
      await this.#stopRemote();
      if (this.#closed) return;
      this.#set({ config, phase: config.enabled ? "connecting" : "disabled", error: undefined });
      if (config.enabled) {
        this.#timer = window.setInterval(this.request, config.intervalSeconds * 1000);
      }
    });
    this.#configureTail = apply.catch(() => undefined);
    return apply;
  }

  readonly #onStorage = (event: StorageEvent) => {
    if (!this.#storageKey) return;
    if (event.key === `${this.#storageKey}-request`) this.request();
  };

  readonly kernelChanged = () => {
    if (this.#database && !this.#closed) void this.#reconcile().catch((error: unknown) => this.#fail(error));
  };

  #reconcile(): Promise<void> {
    this.#dirty = true;
    return this.#reconciling ??= (async () => {
      while (this.#dirty && !this.#closed) {
        this.#dirty = false;
        const { workspaceId, records } = await this.kernel.syncRecords();
        if (workspaceId !== this.#workspaceId) throw new Error("The SiYuan workspace changed. Reload Still to continue.");
        const incoming = await mergeKernelRecords(this.#database!.records, records);
        for (let i = 0; i < incoming.length && !this.#closed; i += SYNC_BATCH_SIZE) {
          await this.kernel.applySyncRecords(incoming.slice(i, i + SYNC_BATCH_SIZE));
        }
      }
    })().finally(() => { this.#reconciling = undefined; });
  }

  readonly request = () => {
    void this.#sync().catch((error: unknown) => this.#fail(error));
  };

  async #sync() {
    await this.#load();
    if (!this.#database || this.#closed) return;
    await this.#reconcile();
    await this.#configureTail;
    if (this.#closed || !this.#state.config.enabled) return;
    if (!this.#replication) await this.#connect();
    this.#replication?.reSync();
  }

  #connect(): Promise<void> {
    return this.#connecting ??= (async () => {
      const { config } = this.#state;
      const client = supabaseClient(normalizeConfig(config), this.#workspaceId);
      this.#remote = client;
      try {
        const userId = await authenticate(client, config);
        if (userId !== config.userId) throw new Error("The Supabase account changed. Save your connection settings again.");
        if (this.#closed || this.#remote !== client) return;
        const transport = supabaseTransport(client);
        this.#set({ phase: "ready", error: undefined });
        this.#replication = replicateStill(this.#database!.records, `still-v1-${syncHash(`${config.url}/${userId}`)}`, {
          pull: async (...args) => {
            const rows = await transport.pull(...args);
            if (this.#remote === client && this.#state.phase !== "ready") this.#set({ phase: "ready", error: undefined });
            return rows;
          },
          push: (records) => transport.push(records),
        });
        this.#replication.error$.subscribe(() => {
          if (this.#remote === client) this.#fail(new Error("Supabase sync failed. The plugin will retry automatically."));
        });
      } catch (error) {
        client.auth.stopAutoRefresh();
        if (this.#remote !== client) return;
        this.#remote = undefined;
        throw error;
      }
    })().finally(() => { this.#connecting = undefined; });
  }

  async #stopRemote() {
    window.clearInterval(this.#timer);
    this.#remote?.auth.stopAutoRefresh();
    this.#remote = undefined;
    await this.#connecting?.catch(() => undefined);
    await this.#replication?.cancel();
    this.#replication = undefined;
  }

  async test(config: SyncConfig, password: string) {
    await this.#load();
    const normalized = normalizeConfig(config);
    const client = supabaseClient(normalized, password ? undefined : this.#workspaceId);
    try {
      await authenticate(client, normalized, password || undefined);
      const remote = supabaseTransport(client);
      await remote.pull("0", 1);
      await remote.push([]);
    } finally {
      client.auth.stopAutoRefresh();
    }
  }

  async save(config: SyncConfig, password: string) {
    await this.#load();
    const previous = this.#state.config;
    let next: SyncConfig;
    if (!config.enabled && !password && !config.url.trim() && !config.key.trim() && !config.email.trim()) {
      next = { ...DEFAULT_SYNC_CONFIG };
    } else {
      const normalized = normalizeConfig(config);
      const sameAccount = previous.url === normalized.url && previous.email === normalized.email;
      next = { ...normalized, userId: sameAccount ? previous.userId : undefined };
      if (password || normalized.enabled) {
        const client = supabaseClient(normalized, this.#workspaceId);
        try {
          next.userId = await authenticate(client, normalized, password || undefined);
        } finally {
          client.auth.stopAutoRefresh();
        }
      }
    }
    await this.configStorage.save(next);
    await this.#applyConfig(next);
    this.request();
  }

  syncNow() {
    localStorage.setItem(`${this.#storageKey}-request`, String(Date.now()));
    this.request();
  }

  async close() {
    this.#closed = true;
    window.removeEventListener("storage", this.#onStorage);
    window.removeEventListener("online", this.request);
    this.#changes?.unsubscribe();
    await this.#configureTail;
    await this.#stopRemote();
    await this.#reconciling?.catch(() => undefined);
    await this.#database?.close();
  }
}
