import type { Subscription } from "@still/core";
import { CalendarDaysIcon, ChartPieIcon, ListIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { useI18n, useStill } from "../../context.js";
import { PendingSection } from "../PendingSection.js";
import { SettingsView } from "../settings/SettingsView.js";
import { StatusState } from "../StatusState.js";
import { SubscriptionDialog } from "../SubscriptionDialog.js";
import { CalendarView } from "./CalendarView.js";
import { ManagerHero } from "./ManagerHero.js";
import { InsightsView } from "./InsightsView.js";
import { SubscriptionList } from "./SubscriptionList.js";

export type ManagerTab = "list" | "calendar" | "insights" | "settings";

/** Full-page view: totals, every subscription, calendar, insights and settings. */
export function ManagerView({ initialTab = "list", settingsExtra }: { initialTab?: ManagerTab; settingsExtra?: ReactNode }) {
  const { t } = useI18n();
  const status = useStill((s) => s.status);
  const [tab, setTab] = useState<ManagerTab>(initialTab);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [open, setOpen] = useState(false);

  const openEditor = (sub: Subscription | null) => {
    setEditing(sub);
    setOpen(true);
  };

  return (
    <div className="still-panel stl-manager still:min-h-full still:@container">
      <div className="still:mx-auto still:flex still:w-full still:max-w-5xl still:flex-col still:gap-5 still:p-4 still:@2xl:p-8">
        <header className="still:flex still:flex-wrap still:items-end still:justify-between still:gap-3">
          <div>
            <h1 className="stl-page-title">{t("appName")}</h1>
            <p className="still:text-sm still:text-muted-foreground">{t("tagline")}</p>
          </div>
          <Button onClick={() => openEditor(null)} disabled={status !== "ready"}>
            <PlusIcon />
            {t("addSubscription")}
          </Button>
        </header>

        <StatusState rows={4} />

        {status === "ready" && (
          <>
            <ManagerHero />

            <PendingSection className="stl-pending-wide" />

            <Tabs value={tab} onValueChange={(v) => setTab(v as ManagerTab)} className="still:flex still:flex-col still:gap-4">
              <TabsList className="stl-tabs still:self-start still:max-w-full still:overflow-x-auto">
                <TabsTrigger value="list"><ListIcon />{t("manager.tab.list")}</TabsTrigger>
                <TabsTrigger value="calendar"><CalendarDaysIcon />{t("manager.tab.calendar")}</TabsTrigger>
                <TabsTrigger value="insights"><ChartPieIcon />{t("manager.tab.insights")}</TabsTrigger>
                <TabsTrigger value="settings"><Settings2Icon />{t("manager.tab.settings")}</TabsTrigger>
              </TabsList>
              <TabsContent value="list"><SubscriptionList onEdit={openEditor} /></TabsContent>
              <TabsContent value="calendar"><CalendarView onEdit={openEditor} /></TabsContent>
              <TabsContent value="insights"><InsightsView onEdit={openEditor} /></TabsContent>
              <TabsContent value="settings"><SettingsView extra={settingsExtra} /></TabsContent>
            </Tabs>
          </>
        )}
      </div>
      <SubscriptionDialog open={open} onOpenChange={setOpen} subscription={editing} />
    </div>
  );
}
