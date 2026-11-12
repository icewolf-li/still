/**
 * Still's service, independent of where it runs. Owns all reads and writes of
 * Still's data, schedules reminders, and delivers push and daily-note entries.
 * Hosts adapt it to their transport (SiYuan: kernel RPC; Obsidian: direct calls).
 */
import {
  StillRepository,
  ValidationError,
  cancellationEndDate,
  computeDueReminders,
  createHlcClock,
  indexDecisions,
  isLocalDate,
  isStillBackup,
  localDateOf,
  localMinutesOf,
  parseRatesPayload,
  toSubscriptionInput,
  validateChannel,
  type Decision,
  type DueReminder,
  type ExchangeRates,
  type NotificationSettings,
  type Settings,
  type Snapshot,
  type StillBackup,
  type Subscription,
} from "@still/core";
import type { DeviceInfo, EngineHost } from "./host.js";
import { Notifier, type ChannelTestResult } from "./notifier.js";

/** How often the reminder scheduler wakes up. */
export const TICK_MS = 60_000;
/** Exchange rates are refreshed at most this often… */
const RATES_MAX_AGE_MS = 12 * 60 * 60_000;
/** …and after a failed attempt, retried no sooner than this. */
const RATES_RETRY_MS = 60 * 60_000;
/** Tried in order; both are free and need no API key. */
const RATE_SOURCES = [
  { url: "https://open.er-api.com/v6/latest/USD", source: "ExchangeRate-API" },
  { url: "https://api.frankfurter.app/latest?from=USD", source: "Frankfurter (ECB)" },
];

export interface DecideResult {
  decision: Decision;
  /** The subscription after the decision ("cancel" ends it). */
  subscription: Subscription;
}

export interface ImportResult {
  subscriptions: number;
  decisions: number;
  skipped: number;
}

/** Serialises async sections so concurrent calls can't interleave read-modify-write. */
function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export class StillEngine {
  readonly repo: StillRepository;
  readonly #host: EngineHost;
  readonly #notifier: Notifier;
  readonly #exclusive = createMutex();
  /** Keys already announced during this session, so each tick doesn't re-announce them. */
  readonly #announced = new Set<string>();
  #stop: (() => void) | null = null;
  #ticking = false;
  #tickAgain = false;
  #lastRatesAttempt = 0;

  constructor(host: EngineHost) {
    this.#host = host;
    this.repo = new StillRepository({ files: host.files, clock: createHlcClock(host.device.deviceId) });
    this.#notifier = new Notifier(this.repo, host);
  }

  /** Runs a first tick and schedules the rest. */
  start(): void {
    if (this.#stop) return;
    void this.tick();
    this.#stop = this.#host.every(TICK_MS, () => void this.tick());
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
  }

  #clock() {
    const now = this.#host.now?.() ?? new Date();
    return { today: localDateOf(now), minutes: localMinutesOf(now) };
  }

  /** After our own writes: let the host update its view of storage, tell views, re-check reminders. */
  async #changed() {
    await this.#host.afterWrite?.();
    await this.#host.emit({ type: "changed", source: "write" });
    // Edits can move a charge date into a reminder window right away.
    void this.tick();
  }

  /** The host noticed storage changed elsewhere (sync, another device, a text editor). */
  async externalChange(): Promise<void> {
    await this.#host.emit({ type: "changed", source: "storage" });
    void this.tick();
  }

  // ───────────────────────── reads ─────────────────────────

  async snapshot(): Promise<Snapshot> {
    const [subscriptions, settings, decisions, rates] = await Promise.all([
      this.repo.listSubscriptions(),
      this.repo.getSettings(),
      this.repo.listDecisions(),
      this.repo.getRates(),
    ]);
    return { subscriptions, settings, decisions, rates };
  }

  async #dueState() {
    const [subscriptions, settings, delivered, decisions] = await Promise.all([
      this.repo.listSubscriptions(),
      this.repo.getSettings(),
      this.repo.readDelivered(),
      this.repo.listDecisions(),
    ]);
    const clock = this.#clock();
    const index = indexDecisions(decisions);
    return {
      subscriptions,
      settings,
      clock,
      /** Not yet shown in any view. */
      due: computeDueReminders(subscriptions, settings, clock, delivered, index),
      /** Due regardless of view delivery; push keeps its own log (`push|…`). */
      dueForPush: computeDueReminders(subscriptions, settings, clock, new Set(), index),
    };
  }

  async pendingReminders(): Promise<DueReminder[]> {
    return (await this.#dueState()).due;
  }

  deviceInfo(): DeviceInfo {
    return this.#host.device;
  }

  // ───────────────────────── scheduling ─────────────────────────

  async tick(): Promise<void> {
    // Never overlap (a push round can be slow); re-run once if asked meanwhile.
    if (this.#ticking) {
      this.#tickAgain = true;
      return;
    }
    this.#ticking = true;
    void this.refreshRates();
    try {
      const { due, dueForPush, subscriptions, settings, clock } = await this.#dueState();
      const fresh = due.filter((r) => !this.#announced.has(r.key));
      for (const r of fresh) this.#announced.add(r.key);
      if (fresh.length) await this.#host.emit({ type: "reminders-due", reminders: fresh });
      // Push and journal independently of any view being open.
      await this.#notifier.pushReminders(dueForPush, subscriptions);
      await this.#notifier.journalCharges(subscriptions, settings, clock);
    } catch (e) {
      await this.#host.log.error("reminder tick failed", String(e));
    } finally {
      this.#ticking = false;
      if (this.#tickAgain) {
        this.#tickAgain = false;
        void this.tick();
      }
    }
  }

  /** Fetches exchange rates when conversion is on and the cache is stale (or `force`). */
  async refreshRates(force = false): Promise<ExchangeRates | null> {
    const now = Date.now();
    if (!force && now - this.#lastRatesAttempt < RATES_RETRY_MS) return this.repo.getRates();
    const settings = await this.repo.getSettings();
    if (!settings.convertCurrency && !force) return this.repo.getRates();
    const cached = await this.repo.getRates();
    if (!force && cached && now - Date.parse(cached.fetchedAt) < RATES_MAX_AGE_MS) return cached;
    this.#lastRatesAttempt = now;
    for (const { url, source } of RATE_SOURCES) {
      try {
        const res = await this.#host.http({ url, timeoutMs: 8_000 });
        const rates = res.status === 200 ? parseRatesPayload(res.json(), new Date().toISOString(), source) : null;
        if (!rates) continue;
        await this.#exclusive(() => this.repo.saveRates(rates));
        await this.#changed();
        return rates;
      } catch (e) {
        await this.#host.log.warn(`exchange rates from ${source} failed`, String(e));
      }
    }
    return this.repo.getRates();
  }

  /**
   * The user just told us about this subscription, so don't ask "still using
   * it?" about a charge that's already inside the reminder window. A regular
   * renewal counts as kept; a trial conversion stays in "Waiting for you"
   * (that reminder is too valuable to drop) but doesn't pop up a card.
   */
  async #settleNew(sub: Subscription) {
    const settings = await this.repo.getSettings();
    const due = computeDueReminders([sub], settings, this.#clock(), new Set(), new Map());
    for (const r of due) {
      if (r.kind === "renewal") await this.repo.decide(sub.id, r.chargeDate, "keep");
      else await this.repo.markDelivered(this.#host.device.deviceId, [r.key]);
    }
  }

  // ───────────────────────── writes ─────────────────────────

  /** `options.settle: false` keeps reminders for an imminent charge (demo/seed data, imports). */
  createSubscription(input: unknown, options?: { settle?: boolean }): Promise<Subscription> {
    return this.#exclusive(async () => {
      const record = await this.repo.createSubscription(input);
      if (options?.settle !== false) await this.#settleNew(record);
      await this.#changed();
      return record;
    });
  }

  updateSubscription(id: string, input: unknown): Promise<Subscription> {
    return this.#exclusive(async () => {
      const record = await this.repo.updateSubscription(id, input);
      await this.#changed();
      return record;
    });
  }

  deleteSubscription(id: string): Promise<null> {
    return this.#exclusive(async () => {
      await this.repo.deleteSubscription(id);
      await this.#changed();
      return null;
    });
  }

  updateSettings(patch: unknown): Promise<Settings> {
    return this.#exclusive(async () => {
      const settings = await this.repo.updateSettings(patch);
      await this.#changed();
      return settings;
    });
  }

  async exportData(): Promise<StillBackup> {
    const [subscriptions, decisions, settings] = await Promise.all([this.repo.listSubscriptions(), this.repo.listDecisions(), this.repo.getSettings()]);
    return { app: "still", format: 1, exportedAt: new Date().toISOString(), subscriptions, decisions, settings };
  }

  /** Merges a backup record by record; newer edits win on both sides. */
  importData(backup: unknown): Promise<ImportResult> {
    if (!isStillBackup(backup)) return Promise.reject(new ValidationError(["not a Still backup file"]));
    return this.mergeRecords(backup.subscriptions, backup.decisions);
  }

  /** Applies imported or replicated records, including tombstones, under the write lock. */
  mergeRecords(subscriptions: readonly Subscription[], decisions: readonly Decision[]): Promise<ImportResult> {
    return this.#exclusive(async () => {
      const result: ImportResult = { subscriptions: 0, decisions: 0, skipped: 0 };
      for (const s of subscriptions) {
        if (await this.repo.mergeSubscription(s)) result.subscriptions++;
        else result.skipped++;
      }
      for (const d of decisions) {
        if (await this.repo.mergeDecision(d)) result.decisions++;
        else result.skipped++;
      }
      if (result.subscriptions || result.decisions) await this.#changed();
      return result;
    });
  }

  getNotifications(): Promise<NotificationSettings> {
    return this.repo.getNotifications();
  }

  saveNotifications(settings: unknown): Promise<NotificationSettings> {
    return this.#exclusive(async () => {
      const saved = await this.repo.saveNotifications(settings);
      void this.tick(); // a newly added channel may have reminders waiting
      return saved;
    });
  }

  async testChannel(raw: unknown): Promise<ChannelTestResult> {
    const result = validateChannel(raw);
    if (!result.ok) throw new ValidationError(result.errors);
    return this.#notifier.send(result.value, this.#notifier.testMessage());
  }

  /**
   * Marks reminders delivered and returns the subset this caller won. With
   * several views or devices open, exactly one of them shows each card.
   */
  claimReminders(keys: unknown): Promise<string[]> {
    return this.#exclusive(async () => {
      if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) throw new ValidationError(["keys must be an array of strings"]);
      const delivered = await this.repo.readDelivered();
      const claimed = (keys as string[]).filter((k) => !delivered.has(k));
      if (claimed.length) await this.repo.markDelivered(this.#host.device.deviceId, claimed);
      return claimed;
    });
  }

  /** Answers "still using it?" for one charge. "cancel" also ends the subscription. */
  decide(subscriptionId: string, chargeDate: unknown, choice: unknown, snoozeUntil?: unknown): Promise<DecideResult> {
    return this.#exclusive(async () => {
      const decision = await this.repo.decide(subscriptionId, chargeDate, choice, snoozeUntil);
      let subscription = (await this.repo.getSubscription(subscriptionId))!;
      if (decision.choice === "cancel" && subscription.status !== "cancelled") {
        subscription = await this.repo.updateSubscription(subscriptionId, {
          ...toSubscriptionInput(subscription),
          status: "cancelled",
          endDate: cancellationEndDate(this.#clock().today, decision.chargeDate),
        });
        void this.#notifier.journalCancellation(subscription);
      }
      await this.#changed();
      return { decision, subscription };
    });
  }

  /** Withdraws a decision; `restore` puts the subscription back as it was before. */
  undoDecision(subscriptionId: string, chargeDate: unknown, restore?: unknown): Promise<Subscription | null> {
    return this.#exclusive(async () => {
      if (!isLocalDate(chargeDate)) throw new ValidationError(["chargeDate must be a YYYY-MM-DD date"]);
      await this.repo.clearDecision(subscriptionId, chargeDate);
      const subscription = restore ? await this.repo.updateSubscription(subscriptionId, restore) : await this.repo.getSubscription(subscriptionId);
      await this.#changed();
      return subscription;
    });
  }
}
