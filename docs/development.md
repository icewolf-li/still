# Developing Still

## Layout

```
packages/core     Platform-independent domain logic (no DOM, no Intl, no crypto):
                  calendar dates, billing cycles, money, HLC timestamps,
                  reminders, file-per-record repository. Runs in goja.
packages/engine   The service every host runs: owns reads/writes, schedules
                  reminders, claims them across devices, pushes, writes daily
                  notes. Hosts plug in storage, HTTP, timers and events.
packages/ui       React + shadcn/ui views shared by every host. Tailwind classes
                  are prefixed `still:`; no global preflight. Eight themes render
                  one superset markup (`stl-*`) styled per theme with @scope.
apps/siyuan       SiYuan plugin: kernel.js (goja; runs the engine behind RPC) and
                  index.js (frontend: dock, tab, status bar, reminder card).
apps/obsidian     Obsidian plugin: main.js runs the engine in-process over a vault
                  folder (default `Still/`); sidebar, manager tab, settings tab.
                  Its CSS is lifted one id of specificity above Obsidian's
                  element styles at build time.
tools/goja-runner Runs JS in the same goja setup SiYuan uses, for tests.
```

## Commands

```bash
pnpm install
pnpm test        # core unit tests + kernel.js end-to-end in real goja (needs Go)
pnpm typecheck
pnpm build       # apps/siyuan/dist + package.zip, apps/obsidian/dist
```

Develop against a dedicated SiYuan workspace (needs SiYuan 3.8.5+ installed; the
script uses its kernel binary, trusts bazaar plugins and turns update downloads off):

```bash
pnpm --filter @still/siyuan dev                     # rebuild on change
node apps/siyuan/scripts/serve.mjs                  # kernel on :6899, workspace ~/SiYuan/still-dev
node apps/siyuan/scripts/seed.mjs --reset           # demo data
node tools/snap/snap.mjs /tmp/snaps                 # Playwright screenshots for visual QA
```

Or link `dist/` into an existing workspace with `node apps/siyuan/scripts/link.mjs <workspace>`.

### Obsidian

```bash
pnpm --filter @still/obsidian dev                   # rebuild apps/obsidian/dist on change
node apps/obsidian/scripts/link.mjs <vault>         # symlink dist into <vault>/.obsidian/plugins/still
```

For automated checks, run an isolated Obsidian (its own profile and vault list,
leaving yours untouched) with the DevTools protocol on:

```bash
/Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir=/tmp/still-obsidian --remote-debugging-port=9333
node apps/obsidian/scripts/seed.mjs --reset --lang en   # demo data through the plugin's engine
```

`app.plugins.plugins.still.engine` exposes the same API the views use.

Tutorial clips live in `docs/tutorial/clips/` and are recorded with the
make-kmind-tutorial-slice-lite pipeline against the dev kernel.

## Design notes

- **The kernel plugin is the single writer.** The frontend calls it over
  JSON-RPC (`apps/siyuan/src/shared/rpc.ts`); it broadcasts `changed` and
  `reminders-due`. Reminders are computed even when no window is open.
- **SiYuan sync** uses a kernel copy in `conf/still/records-v1.json` and an
  RxDB/Dexie replica in the frontend. With Supabase enabled, the frontend
  replicates subscriptions and renewal decisions. Deletes are tombstones, and
  the `updatedAt` hybrid logical clock determines which record version wins.
- **SiYuan settings** use the official `data/storage/petal/still/` directory:
  `settings-v2.json` and `notifications-v2.json`. The kernel uses the file API
  for the same storage as frontend `loadData/saveData`, preserving headless
  reminders. Settings are read on demand, not cached in the records snapshot.
  Migration prefers existing official settings and backs up the previous local
  snapshot before removing its settings. Old individual files stay untouched.
  Supabase connection parameters use a separate `supabase-connection-v1.json`
  via frontend `loadData/saveData`, migrating the workspace's old localStorage
  key only after a successful save. Passwords and Auth sessions stay device-local.
  `onDataChanged` and `sync-end` refresh settings and reconfigure remote sync.
- **Dates are civil dates** (`YYYY-MM-DD`), never instants. Month cycles are
  computed from the anchor (Jan 31 → Feb 28 → Mar 31). The kernel uses the
  host time zone; Docker deployments should set `TZ`.
- **Reminders** collapse missed thresholds into the most urgent one, wait for
  `notifyAt` on the day, and are claimed atomically so only one window shows
  each one. Delivery logs are per device (`delivered/<deviceId>.json`).
- **Obsidian has no background process**, so the engine runs inside the
  plugin: reminders, push and daily-note entries happen while Obsidian is open
  on some device, and missed ones are caught up on the next start or focus.
  Records live in a vault folder (default `Still/`) so
  any vault sync carries them; per-device delivery logs keep every reminder to
  one device.

## Releasing

Both plugins ship from one GitHub release. Obsidian looks up the release by its
bare version tag and reads `manifest.json` and `versions.json` from the
repository root. The SiYuan bazaar installs `package.zip` from the latest release.

1. Bump `apps/siyuan/plugin.json` and `manifest.json` to the same version. Add
   that version to `versions.json` and add the release notes at the top of
   `CHANGELOG.md`.
2. Run `node tools/check-release.mjs 0.1.4`, using the version being released.
   Once the release changes are merged, tag the release commit and push the tag.

   ```bash
   git tag 0.1.4
   git push origin 0.1.4
   ```

The [Release workflow](../.github/workflows/release.yml) checks the tag and runs
type checks, tests, and builds. It publishes the SiYuan `package.zip` and the
Obsidian `main.js`, `manifest.json`, and `styles.css` with build attestations.
