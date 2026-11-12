import { isStillBackup, type Appearance, type Settings } from "@still/core";
import { DownloadIcon, RefreshCwIcon, UploadIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { Card, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Input } from "../../components/ui/input.js";
import { NativeSelect } from "../../components/ui/native-select.js";
import { ChipToggleGroup } from "../../components/ui/segmented.js";
import { Switch } from "../../components/ui/switch.js";
import { toast } from "../../components/ui/toaster.js";
import { useClient, useHost, useHostInfo, useI18n, useStill } from "../../context.js";
import { COMMON_CURRENCIES } from "../../format.js";
import { parseRpcErrors } from "../errors.js";
import { NotificationsSection } from "./NotificationsSection.js";
import { ThemePicker } from "./ThemePicker.js";

const REMIND_OPTIONS = [0, 1, 2, 3, 5, 7, 14, 30];

/** All settings, saved as you change them. */
export function SettingsView({ extra }: { extra?: ReactNode } = {}) {
  const { t } = useI18n();
  const settings = useStill((s) => s.settings);
  const save = useStill((s) => s.saveSettings);

  const patch = (p: Partial<Settings>) => {
    save(p).catch((e: unknown) => toast.error(parseRpcErrors(e).join("\n")));
  };
  const patchAppearance = (a: Partial<Appearance>) => patch({ appearance: { ...settings.appearance, ...a } });

  return (
    <div className="still:grid still:gap-3">
      <Section title={t("settings.appearance")}>
        <ThemePicker appearance={settings.appearance} onChange={patchAppearance} />
      </Section>

      <Section title={t("settings.reminders")}>
        <Row label={t("settings.notifyAt")}>
          <NotifyAtInput value={settings.notifyAt} onCommit={(notifyAt) => patch({ notifyAt })} />
        </Row>
        <Row label={t("settings.remindDaysBefore")} stacked>
          <DaysChips value={settings.remindDaysBefore} onChange={(remindDaysBefore) => patch({ remindDaysBefore })} />
        </Row>
        <Row label={t("settings.trialRemindDaysBefore")} stacked>
          <DaysChips value={settings.trialRemindDaysBefore} onChange={(trialRemindDaysBefore) => patch({ trialRemindDaysBefore })} />
        </Row>
      </Section>

      <NotificationsSection />

      <Section title={t("settings.currency")}>
        <Row label={t("settings.defaultCurrency")}>
          <NativeSelect
            value={settings.defaultCurrency}
            onChange={(e) => patch({ defaultCurrency: e.target.value })}
            className="still:w-28"
            aria-label={t("settings.defaultCurrency")}
          >
            {(COMMON_CURRENCIES.includes(settings.defaultCurrency) ? COMMON_CURRENCIES : [settings.defaultCurrency, ...COMMON_CURRENCIES]).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </NativeSelect>
        </Row>
        <Row label={t("settings.convert")}>
          <Switch checked={settings.convertCurrency} onCheckedChange={(convertCurrency) => patch({ convertCurrency })} aria-label={t("settings.convert")} />
        </Row>
        {settings.convertCurrency && <RatesInfo />}
      </Section>

      <Section title={t("settings.data")} description={t("settings.exportHint")}>
        <DataActions />
      </Section>

      {extra}
      <About />
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="still:gap-4 still:p-4">
      <CardHeader>
        <CardTitle className="still:font-display">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      {children}
    </Card>
  );
}

function Row({ label, stacked, children }: { label: string; stacked?: boolean; children: ReactNode }) {
  return (
    <div className={stacked ? "still:grid still:gap-1.5" : "still:flex still:items-center still:justify-between still:gap-3"}>
      <span className="still:text-sm">{label}</span>
      {children}
    </div>
  );
}

function DaysChips({ value, onChange }: { value: number[]; onChange(v: number[]): void }) {
  const { t } = useI18n();
  return (
    <ChipToggleGroup
      values={value}
      onChange={(v) => v.length && onChange([...v].sort((a, b) => b - a))}
      options={REMIND_OPTIONS.map((n) => ({ value: n, label: n === 0 ? t("form.remindDay0") : t("form.remindDayN", { n }) }))}
    />
  );
}

function NotifyAtInput({ value, onCommit }: { value: string; onCommit(v: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      type="time"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft && draft !== value && onCommit(draft)}
      className="still:w-28"
    />
  );
}

function RatesInfo() {
  const { t, locale } = useI18n();
  const client = useClient();
  const rates = useStill((s) => s.rates);
  const refresh = useStill((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  if (!client.refreshRates) return null;
  const time = rates ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(rates.fetchedAt)) : null;
  return (
    <div className="still:flex still:items-center still:justify-between still:gap-3 still:text-xs still:text-muted-foreground">
      <span>{rates ? t("settings.ratesInfo", { source: rates.source, time: time! }) : t("settings.ratesNone")}</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          client.refreshRates!()
            .then(() => refresh())
            .catch((e: unknown) => toast.error(parseRpcErrors(e).join("\n")))
            .finally(() => setBusy(false));
        }}
      >
        <RefreshCwIcon className={busy ? "still:animate-spin" : undefined} />
        {t("settings.ratesRefresh")}
      </Button>
    </div>
  );
}

function download(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DataActions() {
  const { t } = useI18n();
  const client = useClient();
  const host = useHost();
  const today = useStill((s) => s.today);
  const refresh = useStill((s) => s.refresh);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!client.exportData || !client.importData) return null;

  async function exportNow() {
    try {
      const backup = await client.exportData!();
      const name = `still-backup-${today}.json`;
      const content = JSON.stringify(backup, null, 2);
      (host.saveFile ?? download)(name, content, "application/json");
    } catch (e) {
      toast.error(parseRpcErrors(e).join("\n"));
    }
  }

  async function importFile(file: File) {
    try {
      const data: unknown = JSON.parse(await file.text());
      if (!isStillBackup(data)) {
        toast.error(t("settings.importInvalid"));
        return;
      }
      const r = await client.importData!(data);
      await refresh();
      toast(t("settings.importDone", { subs: r.subscriptions, decisions: r.decisions, skipped: r.skipped }));
    } catch {
      toast.error(t("settings.importInvalid"));
    }
  }

  return (
    <div className="still:flex still:flex-wrap still:gap-2">
      <Button variant="outline" onClick={() => void exportNow()}>
        <DownloadIcon />
        {t("settings.export")}
      </Button>
      <Button variant="outline" onClick={() => fileRef.current?.click()}>
        <UploadIcon />
        {t("settings.import")}
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="still:hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function About() {
  const { t } = useI18n();
  const { version } = useHostInfo();
  return <p className="still:px-1 still:text-xs still:text-muted-foreground">{t("settings.aboutText", { version: version ? `v${version}` : "" })}</p>;
}
