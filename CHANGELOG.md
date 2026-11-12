# Changelog

## 0.1.4

### SiYuan

- Add optional bidirectional Supabase sync for subscriptions and renewal decisions. Enable it in Still's settings after testing the connection.
- Keep subscriptions available offline with RxDB and resume sync when connectivity returns. Still also pulls after SiYuan finishes a sync.
- Migrate existing records to workspace-local storage. The kernel continues to schedule reminders and write daily notes when no frontend is open.

## 0.1.3

Obsidian: passes the community directory's automated review.

- The Markdown notes and folder moves read only Still's own folder instead of listing every file in the vault
- Release files carry build provenance attestations
- SiYuan: the status bar item and manager tab no longer set inline styles or HTML; nothing looks different

## 0.1.2

Obsidian: meets the community directory's requirements.

- No Node.js APIs, so the plugin stays usable on mobile: devices are named after their platform plus part of their ID (e.g. "Mac · 7f3K") instead of the computer's host name
- Shorter manifest description

## 0.1.1

Still is now available for Obsidian too. Both plugins ship from this release.

### Obsidian (new)

- Sidebar of upcoming charges, manager in a tab, Still's settings in Settings → Still, reminder cards, ribbon icon, commands and (desktop) status bar; works on mobile
- Data as JSON files in a vault folder (default `Still/`, movable from settings), the same format as the SiYuan plugin; changes arriving by sync refresh every view
- Reminders and pushes while Obsidian is open, caught up on start and focus; system notifications on desktop, notices on mobile
- A live ```still code block (`days`, `limit`) and commands to insert an overview or a live block
- Daily-note entries that follow the Daily notes settings (folder, date format, template)
- Optional Markdown notes: one note per subscription with its details as properties, plus a Bases view

### SiYuan

- The reminder and delivery service now lives in a shared engine used by both plugins; behaviour is unchanged
- English wording: no more "STILL · Still" in the header, "in 2 days" stays lower-case mid-sentence, and names are listed with commas

## 0.1.0

First release of Still (续了么), for SiYuan.

### SiYuan

- Reminders computed by a kernel plugin, so they're scheduled even with no window open; one window shows each reminder
- Dock with what's left to pay this month, decisions waiting for you and upcoming charges; status bar shows the next charge
- Daily-note entries for charges and cancellations, a `/续了么` overview table, and a tool for SiYuan's AI agent
- Data in `data/storage/petal/still/`, synced with your workspace

### Both

- Track subscriptions and free trials: any billing cycle, any currency, month-end dates handled correctly
- "Still using it?" decision card before each charge: keep, cancel (with undo and a shortcut to the provider's cancellation page) or decide later
- Push to your phone through Bark, ntfy, Telegram, Server酱 (WeChat), WeCom, DingTalk, Feishu, Discord, Slack, Gotify or a webhook
- Push failures show status information without exposing credentials, request URLs or provider response bodies in notices and logs
- Manager with totals, savings, a six-month forecast, calendar, insights and settings
- ~90 built-in services with brand icons
- Exchange rates to combine multi-currency totals
- Answers play out before the card moves on — a rubber stamp, a wax seal, a torn-off ticket stub, a two-colour stamp or a ticked button, depending on the theme — while the dock follows: a kept charge is marked, a cancelled one is struck out and folded away, totals roll to their new value and the pending count flips. A short entrance on first open; all motion respects reduced-motion settings
- Eight themes — five receipt styles (Thermal, the default; Boutique; Ticket; Riso; Swiss) plus Calm, Wallet and Timeline — each with light and dark
- JSON backup export and import, in the same format on both hosts
