# dsh-agent-clean

[![Release](https://img.shields.io/github/v/release/PolitaryMonicy/dsh-agent-clean?sort=semver&label=release)](https://github.com/PolitaryMonicy/dsh-agent-clean/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

**Cleanup tool for DSH (DeepSeek Harness) subagent entries, sessions and orphaned projection caches.**

Zero dependencies: Node.js built-ins only (`node:zlib` zstd, `node:fs`, `node:child_process`).

> Born out of a real incident: a session's subagent panel got stuck/desynced and the entries could not be removed.
> After reverse-engineering DSH's session log format (v4) and its loader, the **non-destructive** fix was found,
> wrapped into this CLI, and covered by a full regression suite.

> **Two halves — use either one.** The **CLI** is standalone: it works on DSH's files on disk, you run it yourself
> from a terminal, outside DSH, and nothing has to be installed — get it with `git clone` (section 2) or
> **Code → Download ZIP** on the GitHub page. The same package also ships an **optional DSH plugin half**: a host
> route plus a page under **Settings → Session cleanup** that shows what needs cleaning, hands you the exact
> commands, and carries a switch (**on by default**) that runs the non-destructive cleanup for you on the next
> quit (section 2.2). Installing it is optional; the CLI is unaffected. Plugin marketplaces list *npm*
> packages that declare the `dsh` field, so this package can appear there once it is published to npm.

- Never deletes a log line, never renumbers `seq` (v4 requires dense seq; deleting a line makes the whole session fail with `format v4 event N is not dense`)
- Only retypes the session's **own** `subagent/catalog` rows to `subagent/catalog-dismissed` + `ignorable: true`
- Also rewrites the projection cache's `subagentCatalog` to a valid empty state (DSH's `dsh-chat-manager` does **not** remove that cache when a session directory is deleted, leaving orphans behind)
- Full backup before every write; `restore` brings files back byte-for-byte

中文说明见 [README.zh.md](README.zh.md)。

---

## 1. Requirements

| Item | Requirement |
|---|---|
| Node.js | **>= 22** (needs built-in zlib zstd; the CLI checks this on startup and tells you) |
| OS | Windows / macOS / Linux |
| DSH | Desktop app (optional but recommended: used for the "real loader" self-check); otherwise point `--modules` at a node_modules containing `@deepseek-ai/*` |

The DSH home defaults to `~/.dsh` (on Windows `C:\Users\<you>\.dsh`) and can be overridden with `DSH_HOME`:

```
$DSH_HOME/sessions/<escaped-workspace-name>/<session-id>/session.v4.jsonl.zstd   ← session log
$DSH_HOME/storages/session_projcache/sessions/<session-id>.json                  ← projection cache (subagent entries live here)
```

## 2. Get the code, install & run

```bash
git clone https://github.com/PolitaryMonicy/dsh-agent-clean.git
cd dsh-agent-clean
```

(or click **Code → Download ZIP** on the GitHub page and unpack it.) No `npm install` needed — there are no
third-party modules. Pick one:

```bat
:: Windows (double-click or run from a terminal)
clean.cmd list
```

```bash
# macOS / Linux
chmod +x clean.sh
./clean.sh list
```

```bash
# any platform
node clean.mjs list
```

The wrappers locate Node themselves: `%DSH_NODE%` / `$DSH_NODE` → `node` on PATH → common install paths.

### 2.1 Optional: the DSH plugin half

The same package is a DSH plugin (it declares `dsh.bundle.patch` and `dsh.client`), so the Desktop app's plugin
manager can install it:

```bash
dsh plugin --profile desktop add dsh-agent-clean                          # from npm
dsh plugin --profile desktop add github:PolitaryMonicy/dsh-agent-clean    # straight from GitHub
dsh plugin --profile desktop add /path/to/this/repo                       # local checkout
```

Then **quit DSH completely and start it again**. A page appears at **Settings → 会话清理诊断 /
Session cleanup** (the floating 🧹 button older builds had is gone).

The page scans `$DSH_HOME` (the same code as `list` + `orphans`), shows per-session subagent-entry counts, log
sizes, cache titles and orphaned caches, and gives you copy-ready `dismiss` / `purge` / `orphans` commands —
including **one that clears the subagent entries of every session at once**. If the page reports
`宿主返回 HTTP 404`, the host half did not load — check `dsh --profile desktop --dump-config` for the entry and
`%TEMP%\dsh-agent-clean-host.log` for the reason.

The page also carries a switch (see 2.2). Neither the page nor the switch ever touches session storage while DSH
is running: DSH's persistence contract forbids rewriting committed events (`seq` must stay dense, single writer)
and the projection cache has no invalidation API, so even a successful in-process write would leave the old value
in memory. Everything that changes a session happens **after DSH has exited**, through the same `clean.mjs`
pipeline you would run by hand (per-session full backup → structural self-check → real-loader verification).

To remove it: `dsh plugin --profile desktop remove dsh-agent-clean`.

### 2.2 Auto-clean on quit (on by default)

Because you have to restart DSH anyway for a cleaned session to look clean, the plugin can do the cleanup in that
restart window for you. With the switch on (the default), each DSH boot:

1. writes the switch to `auto-arm.json` in the package's state directory, and
2. spawns a **detached helper** (`clean.mjs autowait --pid <the DSH process>`), which survives DSH's exit and
   waits for that pid to disappear.

Once DSH is really gone, the helper runs the same pipeline as `dismiss --all --apply` — full backup per session,
structural self-check, verification with the real loader — over every session that has subagent entries, and
writes `auto-report.json` (`auto.log` keeps a short history). You see the outcome in the page the next time you
start DSH. Turning the switch off needs no restart: a helper that is still waiting re-reads the switch, sees
`enabled: false`, and exits without touching anything. If a second DSH instance is still running at that moment,
the helper skips this window and tries the next one.

This is why the switch lives in the package's own state file rather than in DSH's settings service: a detached
helper cannot read another process's in-memory settings, and this plugin must stay importable with no dependencies
(no `@deepseek-ai/schemastery`) so a local `link:` install keeps working.

Prefer to do it yourself? Turn the switch off and use the commands in the page — they are identical.

## 3. Commands

| Command | What it does |
|---|---|
| `list [--workspace <substr>]` | List sessions, titles, log sizes and each session's **own** subagent entry count |
| `dismiss --session <id\|prefix> [--apply]` | **Remove subagent entries** (non-destructive: keeps every line and seq) |
| `dismiss --all [--workspace <substr>] [--apply]` | Same, for several sessions |
| `purge --session <id\|prefix> [--apply]` | **Delete** the session directory + all generation logs + projection cache (full backup first) |
| `orphans [--apply]` | List/delete projection caches whose session directory is gone |
| `restore --backup <dir>` | Restore from a backup (works for dismiss / purge / orphans backups) |
| `autowait --pid <DSH pid>` | Wait for that DSH process to exit, then dismiss every session that has subagent entries (what the plugin's switch arms at boot; obeys `auto-arm.json`) |
| `version` / `help` | Version / help |

**Common flags**

| Flag | Meaning |
|---|---|
| `--apply` | Without it you get a dry run (default). With it, files are written |
| `--force` | Required when the log was written to in the last 5 minutes (guard against weakening a live session) |
| `--workspace <substr>` | Only touch sessions whose workspace name contains the substring |
| `--no-verify` | Skip only the "no way to self-check" gate. A **failing** real loader still refuses to write |
| `--no-app` | Do not use the desktop app; use plain Node + `--modules` |
| `--app <exe>` / `--asar <app.asar>` | Point at the DSH app explicitly |
| `--modules <node_modules>` | Point at a directory containing `@deepseek-ai/*` |

**Exit codes**: `0` success (after dismiss the projected entry count should be 0); `1` error (including a failed real-loader self-check or bad arguments); `2` self-check passed but entries are still non-zero.

**Suggested flow**: `list` → `dismiss --session <first 8 chars>` (dry run) → add `--apply` → **quit DSH completely and restart**.

## 4. Why it has to be done this way

A v4 session log is a multi-frame zstd JSONL: line 0 is the header (no `seq`), then one event per line with a **dense** `seq` (0,1,2,…).

The DSH client renders the subagent panel from the **projection cache** (`projectionsBySession[].values.subagentCatalog`) with no summary fallback — so changing only the log leaves the entries visible.

Four conditions must hold **at the same time** (all established empirically):

1. **Retype**: turn that entry's `subagent/catalog` event into `subagent/catalog-dismissed` and add `ignorable: true` (unknown types must be ignorable or the loader throws).
2. **Leave the header untouched**: every `session-log-deepseek/delivery-accepted` row's `data.sessionId` must **equal** the header's `id`. Changing only the header id yields
   `SessionFormatError: current-generation delivery marker names the wrong Session`.
3. **Valid empty cache state**: set the projection's `subagentCatalog` value to `{"inheritedEventCount": <n>}` (**not** `head.values: []`, which fails schema validation with `too_small`).
4. **Restart DSH completely** — a running process still holds the old values in memory.

Two more constraints (handled by the tool):

- **Never delete lines**: that breaks seq density → `format v4 event N is not dense` (the reason the original "strip lines" approach failed).
- The loader also verifies that **header.id matches the identity derived from the log path**, so a "mirror" self-check must live under the **same escaped workspace directory name**; otherwise even a correct transform fails with
  `header id "…" and cwd identify "…"`.

## 5. Safety design

- **Dry run by default**; with `--apply` every touched file is first copied **in full** to `backups/<ISO>_<command>_<shortid>/` together with a `manifest.json` recording the original paths (used by `restore`).
- Before writing, the transform is verified on a **mirror** by the **real loader** (the desktop Electron binary running `verify_loader.mjs`); only then are the real files touched. After writing, both the on-disk log and the real loader are re-checked.
- Recompressed frames use `ZSTD_c_checksumFlag = 1`, matching the original format.
- `orphans` only touches files under `storages/session_projcache/sessions/`.
- `purge` backs up **all generation logs** (`session.v3/v4…`) plus the cache, then removes the session directory; `restore` recreates it.
- The auto-clean helper (2.2) is **only ever armed, never in-process**: it waits for the DSH pid to disappear, takes a
  pid-and-timestamp lock so two helpers cannot run at once, skips the window entirely if another DSH instance is
  still running (**the helper itself runs as `DeepSeek Harness.exe` with `ELECTRON_RUN_AS_NODE=1`, so its own pid is
  always excluded from that check**; leftover GPU/renderer children get a 10-second grace), and then goes through exactly the same backup → mirror self-check → real-loader verification path
  as `dismiss --all --apply`. A switch turned off mid-session needs no kill: the waiting helper re-reads
  `auto-arm.json` and exits untouched.

## 6. How correctness is proven

- **Bundled regression suite** (never touches real data): `node test/selftest.mjs` → **33/33 pass** (fake `DSH_HOME`; covers list, orphans, purge+restore, the dismiss safety gate, offline transform, restore rollback, and the auto-clean "is another DSH instance running?" check that must **not** match the helper itself); **36/36 pass** with a real-log fixture (section below).
- **Offline probes** for the two plugin halves (no DSH, no writes to session storage):
  - `npm run probe:client` → `VERDICT A=PASS B=PASS C=PASS` — fakes `window.__ModuleLoader__` and a minimal React
    to prove the settings slot is registered exactly once, that a late `slots` service is still picked up through
    `internal/service` (idempotently), and that a host without `slots` does not throw.
  - `npm run probe:host` → `VERDICT PASS` — drives the host half's two routes with fake requests: fence 403/405,
    the `scan` payload shape, and every `POST /settings` branch (bad body, unknown field, off, on, no double-arm).
    It backs up and restores `auto-arm.json` and arms the helper in dry-run mode (`DSAC_ARM_DRYRUN=1`), so no real
    process is spawned and no cleanup runs.
- **Auto-clean helper** exercised for real: `clean.mjs autowait` prints `开关关闭，未做任何改动。` when the switch is
  off (exit 0) and writes `{"ran":false,"why":"timeout",…}` to `auto-report.json` when the waited pid never dies —
  both without touching a session log.
- **Byte-identical on a real log**: with a real session log (11,443 lines / 12,622,844 B),
  `node test/selftest.mjs --fixture <log> --expect-sha256 B51E6D96F3B4CF922282ECA1BBD11BE175EB9D64EAC676F37F746DAB619C3EBA`
  → the produced sha256 is **identical** to the manually validated fix.
- **Full end-to-end** (real desktop app + fake home): after dismiss the log goes 12,622,844 → 12,624,094 B (sha `B51E6D96…`), the mirror and live real-loader checks both report `OK 投影条目=0`, and the cache goes 117,693 → 111,544 B. `restore` returns the log to 12,622,844 B (sha `2140EFC1…`) and the original cache, **byte-for-byte**.
- Syntax check: `node --check clean.mjs`.

## 7. Caveats

- You **must quit and restart DSH** after a change, or the UI will not reflect it.
- Do not put backup directories inside `$DSH_HOME/sessions/` (they would be treated as sessions).
- To avoid the problem in the first place: spawn fewer long-lived continuable subagents; prefer workflows for batch work.
- A future DSH release may change the session format — re-check section 4 if it does.

## 8. License

MIT, see [LICENSE](LICENSE).
