import { upcomingCharges, type DueReminder, type LocalDate, type Subscription } from "@still/core";
import {
  ManagerView,
  ReminderDialog,
  SubscriptionDialog,
  Toaster,
  UpcomingPanel,
  createStillStore,
  createTranslate,
  formatDaysLeft,
  formatMoney,
  guessCurrency,
  resolveMessages,
  summaryMarkdown,
  type StillHost,
  type StillStore,
  type Translate,
} from "@still/ui";
import { useState } from "react";
import { Dialog, Plugin, confirm, getFrontend, openTab, platformUtils, type Protyle } from "siyuan";
import pluginJson from "../../plugin.json" with { type: "json" };
import { RPC, type RemindersDueParams } from "../shared/rpc.js";
import { createRpcClient, type SiyuanStillClient } from "./client.js";
import { pluginSyncConfig } from "./config-storage.js";
import { ICONS } from "./icons.js";
import { SyncSettings } from "./SyncSettings.js";
import { StillSync } from "./sync-controller.js";
import "./index.css";
import { SCOPE_CLASS, ScopeRegistry, mount, type MountContext } from "./mount.js";

const TAB_TYPE = "manager";
const DOCK_TYPE = "upcoming";
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

function isSiyuanDark(): boolean {
  return document.documentElement.dataset.themeMode === "dark";
}

export default class StillPlugin extends Plugin {
  #client!: SiyuanStillClient;
  #remoteSync!: StillSync;
  #store!: StillStore;
  #scopes!: ScopeRegistry;
  #ctx!: MountContext;
  #t!: Translate;
  #locale = "en";
  #isMobile = false;
  #portal: HTMLElement | null = null;
  #statusBar: HTMLElement | null = null;
  #cleanups: (() => void)[] = [];
  /** Opens the add dialog from commands; set by the always-mounted portal app. */
  #openAdd: (() => void) | null = null;

  override onload() {
    // Publish (read-only) sessions can't reach the kernel plugin's RPC.
    const config = window.siyuan.config;
    if (!config || config.readonly || window.siyuan.isPublish) return;

    const lang = config.lang;
    const { locale, messages } = resolveMessages(lang);
    const hostName = locale.startsWith("zh") ? "思源" : "SiYuan";
    this.#locale = locale;
    const base = createTranslate(messages);
    this.#t = (key, vars) => base(key, { host: hostName, ...vars });
    this.#isMobile = getFrontend() === "mobile" || getFrontend() === "browser-mobile";

    this.#client = createRpcClient(this.kernel.rpc);
    this.#remoteSync = new StillSync(this.#client, pluginSyncConfig(this, localStorage));
    this.#store = createStillStore(this.#client);
    this.#store.setState({ hostDark: isSiyuanDark() });
    this.#scopes = new ScopeRegistry(this.#store);

    // Follow SiYuan's light/dark switch live.
    const observer = new MutationObserver(() => this.#store.setState({ hostDark: isSiyuanDark() }));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-mode"] });
    this.#cleanups.push(() => observer.disconnect());

    this.#portal = document.createElement("div");
    this.#portal.className = "still-root still-siyuan still-portal";
    document.body.append(this.#portal);
    this.#scopes.add(this.#portal);

    const host: StillHost = {
      openUrl: (url) => window.open(url, "_blank", "noopener"),
      confirm: (text) =>
        new Promise((resolve) => confirm(this.#t("appName"), text, () => resolve(true), () => resolve(false))),
      openManager: () => this.openManager(),
    };
    this.#ctx = {
      store: this.#store,
      client: this.#client,
      host,
      lang,
      hostName,
      version: pluginJson.version,
      portalContainer: this.#portal,
      scopes: this.#scopes,
      scopeClassName: SCOPE_CLASS,
    };

    // Window-level UI (reminder card, toasts, add dialog) lives in the portal.
    const portalApp = document.createElement("div");
    this.#portal.append(portalApp);
    this.#cleanups.push(mount(portalApp, <PortalApp register={(open) => (this.#openAdd = open)} />, this.#ctx, { fill: false }));

    this.addIcons(ICONS);
    this.#registerDock();
    this.#registerTab();
    this.addTopBar({
      icon: "iconStill",
      title: this.#t("appName"),
      position: "right",
      callback: () => this.openManager(),
    });
    this.addCommand({
      langKey: "openManager",
      langText: `${this.#t("appName")}: ${this.#t("allSubscriptions")}`,
      hotkey: "",
      callback: () => this.openManager(),
    });
    this.addCommand({
      langKey: "addSubscription",
      langText: `${this.#t("appName")}: ${this.#t("addSubscription")}`,
      hotkey: "",
      callback: () => this.#openAdd?.(),
    });
    this.#registerStatusBar();
    this.protyleSlash = [
      {
        filter: ["still", "xulema", "xlm", "续了么", "订阅", "subscription"],
        html: `<div class="b3-list-item__first"><svg class="b3-list-item__graphic"><use xlink:href="#iconStill"></use></svg><span class="b3-list-item__text">${this.#t("slash.summary")}</span></div>`,
        id: "still-summary",
        callback: (protyle: Protyle) => {
          const lute = protyle.protyle.lute;
          if (lute) protyle.insert(lute.Md2BlockDOM(this.#summaryMarkdown()), true);
        },
      },
    ];

    this.kernel.rpc.bind(RPC.notifyChanged, this.#onChanged);
    this.kernel.rpc.bind(RPC.notifyRemindersDue, this.#onRemindersDue);
    this.eventBus.on("kernel-plugin-state-change", this.#onKernelState);
    this.eventBus.on("sync-end", this.#onSyncEnd);
    // Catch up after the window was hidden (laptop sleep, another app in front).
    document.addEventListener("visibilitychange", this.#onVisible);
    window.addEventListener("focus", this.#onVisible);
  }

  override async onLayoutReady() {
    if (!this.#store) return;
    await this.#sync();
  }

  override async onDataChanged() {
    if (!this.#store) return;
    await Promise.all([this.#remoteSync.reloadConfig(), this.#store.getState().refresh()]);
  }

  readonly #onSyncEnd = () => {
    void this.onDataChanged().catch((error: unknown) => console.warn("[still] configuration reload failed", error));
  };

  override onunload() {
    if (!this.#store) return;
    this.kernel.rpc.unbind(RPC.notifyChanged, this.#onChanged);
    this.kernel.rpc.unbind(RPC.notifyRemindersDue, this.#onRemindersDue);
    this.eventBus.off("kernel-plugin-state-change", this.#onKernelState);
    this.eventBus.off("sync-end", this.#onSyncEnd);
    void this.#remoteSync.close().catch((error: unknown) => console.warn("[still] sync shutdown failed", error));
    document.removeEventListener("visibilitychange", this.#onVisible);
    window.removeEventListener("focus", this.#onVisible);
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
    this.#store.getState().dispose();
    this.#scopes.dispose();
    this.#portal?.remove();
    this.#portal = null;
  }

  openManager() {
    if (this.#isMobile) {
      // `openTab` is a no-op on mobile; use a full-screen dialog instead.
      const dialog = new Dialog({ title: this.#t("appName"), content: "<div></div>", width: "100vw", height: "100vh" });
      const body = dialog.element.querySelector(".b3-dialog__body") as HTMLElement;
      body.classList.add("still-dialog-body");
      const unmount = mount(body, <ManagerView settingsExtra={<SyncSettings sync={this.#remoteSync} />} />, this.#ctx);
      const destroy = dialog.destroy.bind(dialog);
      dialog.destroy = (options) => {
        unmount();
        destroy(options);
      };
      return;
    }
    openTab({ app: this.app, custom: { icon: "iconStill", title: this.#t("appName"), id: this.name + TAB_TYPE, data: {} } });
  }

  #registerDock() {
    const ctx = () => this.#ctx;
    let unmount: (() => void) | null = null;
    this.addDock({
      type: DOCK_TYPE,
      config: {
        position: "RightTop",
        size: { width: 320, height: 0 },
        icon: "iconStill",
        title: this.#t("appName"),
      },
      data: {},
      init() {
        unmount?.();
        unmount = mount(this.element, <UpcomingPanel />, ctx());
      },
      destroy() {
        unmount?.();
        unmount = null;
      },
    });
    this.#cleanups.push(() => unmount?.());
  }

  #registerTab() {
    const ctx = () => this.#ctx;
    const unmounts = new WeakMap<object, () => void>();
    const sync = this.#remoteSync;
    this.addTab({
      type: TAB_TYPE,
      init() {
        (this.element as HTMLElement).classList.add("still-tab");
        unmounts.set(this, mount(this.element, <ManagerView settingsExtra={<SyncSettings sync={sync} />} />, ctx()));
      },
      destroy() {
        unmounts.get(this)?.();
      },
    });
  }

  #registerStatusBar() {
    const el = document.createElement("div");
    el.className = "toolbar__item still-statusbar";
    el.setAttribute("aria-label", this.#t("appName"));
    el.addEventListener("click", () => this.openManager());
    this.#statusBar = this.addStatusBar({ element: el, position: "right" });

    const render = () => {
      const { subscriptions, today, status } = this.#store.getState();
      if (status !== "ready" || !this.#statusBar) return;
      const next = nextChargeWithinWeek(subscriptions, today);
      const label = next ? `${next.subscription.name} · ${formatDaysLeft(next.daysLeft, this.#t)}` : "";
      el.replaceChildren();
      if (label) {
        const svg = document.createElementNS(SVG_NS, "svg");
        const use = document.createElementNS(SVG_NS, "use");
        use.setAttributeNS(XLINK_NS, "xlink:href", "#iconStill");
        svg.append(use);
        const text = document.createElement("span");
        text.textContent = label;
        el.append(svg, text);
      }
      el.title = next ? formatMoney(next.subscription.price, this.#locale) : "";
    };
    this.#cleanups.push(this.#store.subscribe(render));
  }

  /** A Markdown table of live subscriptions, inserted by the `/续了么` slash command. */
  #summaryMarkdown(): string {
    return summaryMarkdown(this.#store.getState(), this.#t, this.#locale);
  }

  #lastSync = 0;
  async #sync() {
    this.#lastSync = Date.now();
    this.#remoteSync.request();
    await this.#store.getState().refresh();
    const { status, settings, saveSettings } = this.#store.getState();
    // First run: pick the currency the user most likely pays in.
    if (status === "ready" && settings.updatedAt === null) {
      void saveSettings({ defaultCurrency: guessCurrency(this.#locale) }).catch(() => undefined);
    }
    try {
      await this.#deliver(await this.#client.pendingReminders());
    } catch (e) {
      console.warn("[still] pendingReminders failed", e);
    }
  }

  async #deliver(reminders: DueReminder[]) {
    if (reminders.length === 0) return;
    const claimed = new Set(await this.#client.claimReminders(reminders.map((r) => r.key)));
    const mine = reminders.filter((r) => claimed.has(r.key));
    if (mine.length === 0) return;
    await this.#store.getState().refresh();
    const { subscriptions } = this.#store.getState();
    for (const r of mine) {
      const sub = subscriptions.find((s) => s.id === r.subscriptionId);
      if (!sub) continue;
      const when = formatDaysLeft(r.daysLeft, this.#t);
      void platformUtils.sendNotification({
        title: this.#t(r.kind === "trial-ending" ? "notification.trialTitle" : "notification.title", { name: sub.name, when }),
        body: this.#t("notification.body", { price: formatMoney(sub.price, this.#locale) }),
      });
    }
    this.#store.getState().enqueueReminders(mine);
  }

  readonly #onChanged = () => {
    this.#remoteSync.kernelChanged();
    void this.#store.getState().refresh();
  };

  readonly #onRemindersDue = (...args: unknown[]) => {
    const params = args[0] as RemindersDueParams | undefined;
    void this.#deliver(params?.reminders ?? []).catch((e) => console.warn("[still] deliver failed", e));
  };

  readonly #onVisible = () => {
    if (document.visibilityState !== "visible" || Date.now() - this.#lastSync < 10_000) return;
    void this.#sync();
  };

  readonly #onKernelState = ({ detail }: CustomEvent<{ code: number }>) => {
    if (detail.code === 2) void this.#sync(); // running
  };
}

/** Window-level UI mounted once: the reminder card, toasts and a command-driven add dialog. */
function PortalApp({ register }: { register(open: () => void): void }) {
  const [adding, setAdding] = useState(false);
  register(() => setAdding(true));
  return (
    <>
      <ReminderDialog />
      <Toaster />
      <SubscriptionDialog open={adding} onOpenChange={setAdding} subscription={null} />
    </>
  );
}

/** Soonest charge within the next week, for the status bar. */
function nextChargeWithinWeek(subscriptions: Subscription[], today: LocalDate) {
  const [first] = upcomingCharges(subscriptions, today);
  return first && first.daysLeft <= 7 ? first : null;
}
