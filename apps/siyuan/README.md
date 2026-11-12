# Still · 续了么

> Before it renews, Still asks: **still using it?**

Still keeps track of your subscriptions and free trials. Before each charge it shows a card — **keep**, **cancel**, or **decide later** — one click.

![Still](https://raw.githubusercontent.com/suka233/still/main/docs/media/preview.png)

## Features

- **Reminders before every charge** — 3 days and 1 day ahead by default, and before free trials convert; same-day reminders wait for your notify time.
- **The "still using it?" card** — what this charge costs and roughly how much you've paid so far. "Cancel it" marks the subscription cancelled with Undo and a shortcut to the provider's cancellation page.
- **Nothing slips when the window is closed** — reminders are computed by a SiYuan kernel plugin, and pushed to your phone through Bark, ntfy, Telegram, Server酱 (WeChat), WeCom, DingTalk, Feishu, Discord, Slack, Gotify or a webhook.
- **A dock that answers "what's next?"** — what's left to pay this month, decisions waiting for you, upcoming charges; the status bar shows the next one.
- **Manager** — monthly and yearly spend, savings, six-month forecast, calendar and category insights.
- **90+ services** with brand icons; search and add.
- **Multi-currency** totals combined with exchange rates.
- **Eight themes** — five receipt styles (Thermal, the default; Boutique; Ticket; Riso; Swiss) plus Calm, Wallet and Timeline — each in light and dark.
- **Made for SiYuan** — optional daily-note entries for charges and cancellations, a `/still` overview table, and a tool for SiYuan's AI agent.
- Subscriptions and renewal decisions support offline storage, JSON backup, and optional bidirectional Supabase sync.

## Demos

| Add a subscription | Still using it? |
|---|---|
| ![Add](https://raw.githubusercontent.com/suka233/still/main/docs/media/still-add-subscription.en-US.webp) | ![Decide](https://raw.githubusercontent.com/suka233/still/main/docs/media/still-decide.en-US.webp) |
| **Decide later** | **Themes** |
| ![Snooze](https://raw.githubusercontent.com/suka233/still/main/docs/media/still-snooze.en-US.webp) | ![Themes](https://raw.githubusercontent.com/suka233/still/main/docs/media/still-themes.en-US.webp) |
| **Calendar & insights** | **Overview in a note** |
| ![Calendar](https://raw.githubusercontent.com/suka233/still/main/docs/media/still-calendar.en-US.webp) | ![Slash](https://raw.githubusercontent.com/suka233/still/main/docs/media/still-slash.en-US.webp) |

Requires SiYuan 3.8.5 or later.

## Supabase sync

1. Apply the `still_rxdb_sync` migration from the repository's `supabase/migrations` directory to your Supabase project. Enable email/password sign-in and create a confirmed Supabase Auth user.
2. In **Still → Settings → Supabase sync**, enter the project HTTPS URL, a publishable or legacy anon key, and the account email and password. Select **Test connection**, then enable sync and save. Use the same Supabase Auth account on your other devices.
3. While a SiYuan frontend is open, Still pushes changes to subscriptions and renewal decisions automatically and polls for remote changes every 60 seconds by default. **Sync now**, plugin startup, network reconnection, and SiYuan's `sync-end` event also request a pull. Offline edits sync on reconnection, and the highest hybrid logical clock version wins when the same record changes on two devices. Deletions sync through `deletedAt`.

Still copies existing `data/storage/petal/still/` files into `conf/still/records-v1.json` on first load. The old files remain available for rollback. The kernel uses the new workspace file for background reminders and journal entries, and RxDB/Dexie (IndexedDB) stores the frontend replica and replication checkpoints. Sync resumes when a SiYuan frontend reopens.

## Privacy

Remote sync is off by default. When enabled, Still sends subscriptions and renewal decisions to the Supabase project you configure. Appearance, notification channels, cached rates, and reminder delivery records stay local. Supabase isolates records by Auth user. Still stores the session locally and uses the password for sign-in. Exchange-rate conversion uses open.er-api.com and Frankfurter and can be turned off in Settings.

MIT · [github.com/suka233/still](https://github.com/suka233/still)
