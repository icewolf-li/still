/**
 * Still kernel plugin. Runs inside SiYuan's Go kernel (goja), independently of
 * any open window. The service itself is `@still/engine`; this file adapts it
 * to SiYuan: workspace storage, forward-proxy HTTP, daily notes and
 * JSON-RPC (see `../shared/rpc.ts`) with `changed` / `reminders-due` pushes.
 */
import { NotFoundError, ValidationError, type FileStore, type Decision, type Subscription } from "@still/core";
import { StillEngine, type DeviceInfo, type EngineHost } from "@still/engine";
import { RPC, type RpcErrorData } from "../shared/rpc.js";
import { registerAgentCapability } from "./agent.js";
import { httpRequest } from "./http.js";
import { journal, listNotebooks, translator } from "./notify.js";
import { openWorkspace } from "./storage.js";
import { decisionRecord, parseSyncRecord, subscriptionRecord } from "../shared/sync.js";

/** This device as SiYuan knows it; the ID is reduced to the characters HLC node IDs allow. */
async function readConf(): Promise<{ device: DeviceInfo; lang: string }> {
  try {
    const res = await siyuan.client.fetch("/api/system/getConf", { method: "POST", body: "{}" });
    const conf = (await res.json())?.data?.conf ?? {};
    const system = conf.system ?? {};
    const lang = String(conf.appearance?.lang ?? "");
    const cleaned = typeof system.id === "string" ? system.id.replace(/[^0-9A-Za-z]/g, "").slice(0, 16) : "";
    if (cleaned) return { device: { deviceId: cleaned, name: String(system.name ?? ""), os: String(system.os ?? siyuan.plugin.platform) }, lang };
  } catch (e) {
    await siyuan.logger.warn("getConf failed, falling back to a random device id", String(e));
  }
  return { device: { deviceId: `r${Math.random().toString(36).slice(2, 12)}`, name: "", os: siyuan.plugin.platform }, lang: "" };
}

function toRpcError(e: unknown): Error {
  if (e instanceof ValidationError) {
    const data: RpcErrorData = { kind: "validation", errors: e.errors };
    return new Error(JSON.stringify(data));
  }
  if (e instanceof NotFoundError) {
    const data: RpcErrorData = { kind: "not-found", errors: [e.message] };
    return new Error(JSON.stringify(data));
  }
  return e instanceof Error ? e : new Error(String(e));
}

let engine: StillEngine;

function createHost(device: DeviceInfo, lang: string, files: FileStore): EngineHost {
  return {
    files,
    device,
    http: httpRequest,
    t: translator(lang),
    async emit(event) {
      if (event.type === "changed") await siyuan.rpc.broadcast(RPC.notifyChanged, { source: event.source === "write" ? "rpc" : "storage" });
      else await siyuan.rpc.broadcast(RPC.notifyRemindersDue, { reminders: event.reminders });
    },
    log: {
      warn: (message, detail) => siyuan.logger.warn(message, detail ?? ""),
      error: (message, detail) => siyuan.logger.error(message, detail ?? ""),
    },
    every(ms, fn) {
      const handle = setInterval(fn, ms);
      return () => clearInterval(handle);
    },
    journal,
  };
}

type Handler = (...args: any[]) => Promise<unknown> | unknown;

function handlers(e: StillEngine, workspaceId: string): Record<string, Handler> {
  return {
    [RPC.snapshot]: () => e.snapshot(),
    [RPC.syncRecords]: async () => {
      const [subscriptions, decisions] = await Promise.all([
        e.repo.listSubscriptions({ includeDeleted: true }),
        e.repo.listDecisions({ includeDeleted: true }),
      ]);
      return { workspaceId, records: [...subscriptions.map(subscriptionRecord), ...decisions.map(decisionRecord)] };
    },
    [RPC.applySyncRecords]: async (raw: unknown) => {
      if (!Array.isArray(raw) || raw.length > 100) throw new ValidationError(["Invalid Still sync batch"]);
      const subscriptions: Subscription[] = [];
      const decisions: Decision[] = [];
      for (const entry of raw) {
        const record = parseSyncRecord(entry);
        if (!record) throw new ValidationError(["Invalid Still sync record"]);
        if (record.id.startsWith("subscription:")) subscriptions.push(record.payload as Subscription);
        else decisions.push(record.payload as Decision);
      }
      return e.mergeRecords(subscriptions, decisions);
    },
    [RPC.createSubscription]: (input: unknown, options?: { settle?: boolean }) => e.createSubscription(input, options),
    [RPC.updateSubscription]: (id: string, input: unknown) => e.updateSubscription(id, input),
    [RPC.deleteSubscription]: (id: string) => e.deleteSubscription(id),
    [RPC.updateSettings]: (patch: unknown) => e.updateSettings(patch),
    [RPC.pendingReminders]: () => e.pendingReminders(),
    [RPC.exportData]: () => e.exportData(),
    [RPC.importData]: (backup: unknown) => e.importData(backup),
    [RPC.getNotifications]: () => e.getNotifications(),
    [RPC.saveNotifications]: (settings: unknown) => e.saveNotifications(settings),
    [RPC.testChannel]: (raw: unknown) => e.testChannel(raw),
    [RPC.deviceInfo]: () => e.deviceInfo(),
    [RPC.listNotebooks]: () => listNotebooks(),
    [RPC.refreshRates]: () => e.refreshRates(true),
    [RPC.claimReminders]: (keys: unknown) => e.claimReminders(keys),
    [RPC.decide]: (subscriptionId: string, chargeDate: unknown, choice: unknown, snoozeUntil?: unknown) => e.decide(subscriptionId, chargeDate, choice, snoozeUntil),
    [RPC.undoDecision]: (subscriptionId: string, chargeDate: unknown, restore?: unknown) => e.undoDecision(subscriptionId, chargeDate, restore),
  };
}

siyuan.plugin.lifecycle.onload = async () => {
  const { device, lang } = await readConf();
  const { id, files } = await openWorkspace();
  engine = new StillEngine(createHost(device, lang, files));
  for (const [name, handler] of Object.entries(handlers(engine, id))) {
    await siyuan.rpc.bind(name, async (...args: unknown[]) => {
      try {
        return await handler(...args);
      } catch (e) {
        throw toRpcError(e);
      }
    });
  }
  await registerAgentCapability(() => engine.repo);
};

siyuan.plugin.lifecycle.onrunning = () => engine.start();
siyuan.plugin.lifecycle.onunload = () => engine?.stop();
