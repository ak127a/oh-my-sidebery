# oh-my-sidebery AI Agent CLI & Local API

`oh-my-sidebery` exposes a local CLI (`sidebery-cli`) and HTTP / Unix-socket API bridged directly to the running Sidebery extension via Firefox Native Messaging (`sidebery_api`). AI agents and scripts can inspect open windows, panels, tab trees, tab groups, and URLs, and create panels, open tabs, group/flatten/move tabs, and set tab colors.

## Setup (macOS / Linux / Windows)

1. Build the extension:
   ```sh
   npm ci
   npm run build
   ```
2. Install the global `sidebery-cli` command, the Firefox native messaging host (`sidebery_api`), and the `sidebery` AI agent skill ([skills/sidebery/SKILL.md](../skills/sidebery/SKILL.md)) in a single command:
   ```sh
   npm run setup:cli
   ```
   Or without cloning:
   ```sh
   npx --yes github:ak127a/oh-my-sidebery install
   ```
   What this configures:
   - **Linux**: `~/.local/share/sidebery-api`, `~/.local/bin/sidebery-cli`, and `sidebery_api.json` in `~/.mozilla/native-messaging-hosts/` and `~/.config/mozilla/native-messaging-hosts/`.
   - **macOS**: `~/.local/share/sidebery-api`, `~/.local/bin/sidebery-cli`, and `sidebery_api.json` in `~/Library/Application Support/Mozilla/NativeMessagingHosts/`.
   - **Windows**: `%LOCALAPPDATA%\sidebery-api`, `sidebery-cli.cmd` in `%APPDATA%\npm` (or `%USERPROFILE%\.local\bin`), and registry key `HKCU\Software\Mozilla\NativeMessagingHosts\sidebery_api`.
   - **AI Skill**: Copies `SKILL.md` into `~/.agents/skills/sidebery/SKILL.md` and detected agent skill directories (`~/.claude`, `~/.codex`, `~/.gemini/config`, `~/.cursor`).
3. Load the built `./addon` directory in Firefox (`about:debugging#/runtime/this-firefox` -> **Load Temporary Add-on** -> select `addon/manifest.json`) or install the packaged add-on.

Verify the global command and connection from any directory:
```sh
sidebery-cli ping
```

To uninstall everything (`sidebery-cli`, native messaging host, and installed skill copies):
```sh
sidebery-cli uninstall
```
(Or `npm run uninstall:cli`.)

---

## CLI Reference

All commands output JSON by default (pretty-printed on a TTY, compact JSON when piped) so agents can parse `stdout` directly. Use `--pretty` or `--compact` to override.

### Inspection
- `sidebery-cli ping` — Check bridge and Sidebery connection status.
- `sidebery-cli state [--window <id>] [--tree]` — Full snapshot (`windows`, `containers`, `panels`, `tabs`, `groups`).
- `sidebery-cli windows` — List open browser windows and sidebar connection state.
- `sidebery-cli panels [--window <id>]` — List panels in a window.
- `sidebery-cli tabs [--window <id>] [--panel <id|name>] [--group <id>] [--color <color>] [--active] [--query <text>] [--tree]` — List tabs with optional filters or ASCII tree formatting.
- `sidebery-cli groups [--window <id>] [--panel <id|name>]` — List group tabs and their member tab IDs.

### Panels
- `sidebery-cli panel create <name> [--color <color>] [--icon <svg>] [--container <id|name>] [--index <n>] [--activate] [--window <id>]`
- `sidebery-cli panel update <id|name> [--name <name>] [--color <color>] [--icon <svg>] [--window <id>]`
- `sidebery-cli panel delete <id|name> [--tabs-mode attach|close|save|leave] [--window <id>]`
- `sidebery-cli panel switch <id|name> [--window <id>]`

### Tabs & Groups
- `sidebery-cli tab create [url...] [--panel <id|name>] [--parent <tabId>] [--index <n>] [--active] [--pinned] [--discarded] [--title <title>] [--color <color>] [--container <id|name>] [--window <id>]`
- `sidebery-cli tab group <tabIds...> [--title <title>] [--active] [--color <color>] [--window <id>]`
- `sidebery-cli tab flatten <tabIds...> [--window <id>]`
- `sidebery-cli tab move <tabIds...> [--panel <id|name>] [--parent <tabId>] [--index <n>] [--pinned] [--window <id>]`
- `sidebery-cli tab color <color> [tabIds...] [--window <id>]` — Valid colors: `blue`, `turquoise`, `green`, `yellow`, `orange`, `red`, `pink`, `purple`, `toolbar` (or `none` / `reset` / `clear`). Omit `tabIds` to color the active tab.
- `sidebery-cli tab title <tabId> <title> [--window <id>]`
- `sidebery-cli tab activate <tabId>`
- `sidebery-cli tab close <tabIds...> [--window <id>]`

### Installer & Raw RPC
- `sidebery-cli install` / `sidebery-cli uninstall`
- `sidebery-cli rpc <method> [jsonParams]`

---

## Local HTTP & Unix Socket API

When Firefox starts Sidebery, the native messaging host (`cli/host.mjs`) starts:
- Unix domain socket at `$XDG_RUNTIME_DIR/sidebery-api.sock` on Linux (`$TMPDIR/sidebery-api.sock` on macOS, mode `0600`)
- Loopback HTTP server at `http://127.0.0.1:47321` (configurable via `SIDEBERY_API_PORT`, falling back to an ephemeral port if in use)
- Discovery file at `$XDG_RUNTIME_DIR/sidebery-api.json` (`$TMPDIR/sidebery-api.json` on macOS, `%TEMP%\sidebery-api.json` on Windows) containing `{ pid, host, port, socket, startedAt }`

### Endpoints
- `GET /api/health`
- `GET /api/state?windowId=...`
- `GET /api/windows`
- `GET /api/panels?windowId=...`
- `POST /api/panels`
- `PATCH /api/panels/:id`
- `DELETE /api/panels/:id`
- `POST /api/panels/:id/activate`
- `GET /api/tabs?windowId=...&panel=...&groupId=...&color=...&active=true&query=...`
- `POST /api/tabs`
- `POST /api/tabs/group`
- `POST /api/tabs/flatten`
- `POST /api/tabs/move`
- `POST /api/tabs/color`
- `POST /api/tabs/title`
- `POST /api/tabs/:id/activate`
- `POST /api/tabs/close`
- `GET /api/groups?windowId=...&panel=...`
- `POST /api/rpc` (`{ "method": "...", "params": { ... } }`)

### Security Model
- The TCP server binds exclusively to `127.0.0.1`.
- Requests carrying an `Origin` header, a cross-site `Sec-Fetch-Site` header, or a non-loopback `Host` header are rejected with `403` to prevent browser CSRF attacks from web pages.
- The Unix socket and discovery file are created with `0600` permissions in `$XDG_RUNTIME_DIR` (or `SIDEBERY_API_DIR` / `os.tmpdir()`).

---

## Example AI Agent Workflow

```sh
# 1. Inspect current panels and tabs as a tree
sidebery-cli tabs --tree

# 2. Create a new colored panel for a research task and switch to it
sidebery-cli panel create "Research" --color purple --activate

# 3. Open tabs inside the new panel
sidebery-cli tab create https://example.com https://developer.mozilla.org --panel Research --color blue

# 4. Group those tabs and highlight the group in turquoise
sidebery-cli tab group 12 13 --title "Docs" --color turquoise
```
