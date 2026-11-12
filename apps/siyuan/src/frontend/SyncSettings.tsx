import { Button, Card, CardDescription, CardHeader, CardTitle, Input, Label, Switch, useI18n } from "@still/ui";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { StillSync } from "./sync-controller.js";

export function SyncSettings({ sync }: { sync: StillSync }) {
  const { locale } = useI18n();
  const state = useSyncExternalStore(sync.subscribe, sync.getState);
  const [draft, setDraft] = useState(state.config);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean }>();
  const id = useId();
  const zh = locale.startsWith("zh");
  const t = (chinese: string, english: string) => zh ? chinese : english;

  useEffect(() => setDraft(state.config), [state.config]);

  async function submit(test: boolean) {
    setBusy(true);
    setFeedback(undefined);
    try {
      if (test) {
        await sync.test(draft, password);
        setFeedback({ message: t("连接成功，已验证登录和同步接口。", "Connected. Sign-in and sync endpoints verified."), error: false });
      } else {
        await sync.save(draft, password);
        setPassword("");
        setFeedback({ message: t("设置已保存。", "Settings saved."), error: false });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFeedback({ message: `${t("操作失败", "Request failed")} · ${message}`, error: true });
    } finally {
      setBusy(false);
    }
  }

  const status = {
    loading: t("正在载入", "Loading"), disabled: t("远程同步已关闭", "Remote sync is off"),
    connecting: t("正在连接", "Connecting"), ready: t("远程同步已启用", "Remote sync is on"),
    error: state.error ?? t("同步失败", "Sync failed"),
  }[state.phase];

  return (
    <Card className="still:gap-4 still:p-4">
      <CardHeader>
        <CardTitle className="still:font-display">{t("Supabase 远程同步", "Supabase sync")}</CardTitle>
        <CardDescription>{t("在使用同一个 Supabase Auth 账号的设备间同步订阅和续费决策。", "Sync subscriptions and renewal decisions between devices using the same Supabase Auth account.")}</CardDescription>
      </CardHeader>
      <fieldset disabled={busy || state.phase === "loading"} className="still:grid still:min-w-0 still:gap-3">
        <div className="still:flex still:items-center still:justify-between still:gap-3">
          <Label htmlFor={`${id}-enabled`}>{t("启用远程同步", "Enable remote sync")}</Label>
          <Switch id={`${id}-enabled`} checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
        </div>
        <div className="still:grid still:gap-3 still:sm:grid-cols-2">
          <div className="still:grid still:gap-1.5">
            <Label htmlFor={`${id}-url`}>{t("项目 URL", "Project URL")}</Label>
            <Input id={`${id}-url`} type="url" value={draft.url} placeholder="https://your-project.supabase.co" onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          </div>
          <div className="still:grid still:gap-1.5">
            <Label htmlFor={`${id}-key`}>{t("Publishable Key 或 anon Key", "Publishable or anon key")}</Label>
            <Input id={`${id}-key`} value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} autoComplete="off" spellCheck={false} />
          </div>
          <div className="still:grid still:gap-1.5">
            <Label htmlFor={`${id}-email`}>{t("Supabase Auth 邮箱", "Supabase Auth email")}</Label>
            <Input id={`${id}-email`} type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} autoComplete="username" />
          </div>
          <div className="still:grid still:gap-1.5">
            <Label htmlFor={`${id}-password`}>{t("登录密码", "Password")}</Label>
            <Input id={`${id}-password`} type="password" value={password} placeholder={t("首次登录或会话失效时填写", "Needed for first sign-in or expired sessions")} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          <div className="still:grid still:gap-1.5">
            <Label htmlFor={`${id}-interval`}>{t("远端拉取间隔（秒）", "Remote pull interval (seconds)")}</Label>
            <Input id={`${id}-interval`} type="number" min={15} max={3600} value={draft.intervalSeconds || ""} onChange={(e) => setDraft({ ...draft, intervalSeconds: Number(e.target.value) })} />
          </div>
        </div>
        <div className="still:flex still:flex-wrap still:gap-2">
          <Button onClick={() => void submit(false)}>{t("保存设置", "Save settings")}</Button>
          <Button variant="outline" onClick={() => void submit(true)}>{t("一键测试连接", "Test connection")}</Button>
          <Button variant="outline" disabled={!state.config.enabled} onClick={() => { sync.syncNow(); setFeedback({ message: t("已请求同步。", "Sync requested."), error: false }); }}>{t("立即同步", "Sync now")}</Button>
        </div>
      </fieldset>
      <p role="status" className={state.phase === "error" ? "still:text-sm still:text-destructive" : "still:text-sm still:text-muted-foreground"}>{status}</p>
      {feedback && <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "still:text-sm still:text-destructive" : "still:text-sm"}>{feedback.message}</p>}
    </Card>
  );
}
