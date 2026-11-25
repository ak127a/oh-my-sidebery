---
name: sidebery
description: Inspect and control Firefox tabs, Sidebery panels, tab trees, tab groups, and tab colors via sidebery-cli or the local Sidebery HTTP API. Use when asked to read open browser tabs, find URLs, organize/group tabs, create or switch Sidebery panels, open links in specific panels, or color-code tabs in Firefox.
---

# Sidebery Firefox Control

Use `sidebery-cli` to inspect and manipulate open Firefox windows, Sidebery panels, tab trees, tab groups, and tab colors.

All commands output JSON by default (`--pretty` for indented output, `--compact` for single-line JSON, `--tree` on `tabs`/`state` for an ASCII tree).

## 1. Check Connection

```sh
sidebery-cli ping
```

If `sidebery-cli` reports `ECONNREFUSED` or `ENOENT`:
1. Ensure Firefox is running with this Sidebery extension loaded and a Sidebery sidebar open.
2. Ensure the native messaging host is registered (`sidebery-cli install`).

## 2. Inspect Windows, Panels, Tabs, and Groups

Always inspect panels and tabs first so you know real IDs, panel names, and tree structure before making changes.

```sh
# Human-readable tree of all panels, groups, colors, and URLs
sidebery-cli tabs --tree

# Full JSON snapshot (windows, containers, panels, tabs, groups)
sidebery-cli state

# List windows / panels / groups
sidebery-cli windows
sidebery-cli panels
sidebery-cli groups

# Filter tabs
sidebery-cli tabs --panel "Research" --tree
sidebery-cli tabs --query "github.com"
sidebery-cli tabs --color blue
sidebery-cli tabs --active
```

Key fields on tabs: `id`, `windowId`, `panelId`, `parentId`, `groupId`, `lvl`, `isGroup`, `childrenIds`, `customColor`, `customTitle`, `url`, `title`, `active`, `pinned`, `discarded`.

## 3. Panels

```sh
# Create a panel (optionally activate it)
sidebery-cli panel create "Research" --color purple --icon icon_search --activate

# Update panel name, color, or icon
sidebery-cli panel update <id|name> --name "Docs" --color blue

# Switch active panel
sidebery-cli panel switch <id|name>

# Delete a panel (tabsMode: attach | close | save | leave; default: attach)
sidebery-cli panel delete <id|name> --tabs-mode close
```

Common panel `--icon` IDs: `icon_tabs`, `icon_search`, `icon_code`, `icon_books`, `icon_coffee`, `icon_flask`, `icon_play`, `icon_mail`, `icon_archive`, `icon_lock`, `briefcase`, `cart`, `dollar`.

## 4. Open, Organize, Group, and Color Tabs

```sh
# Open one or more URLs in a specific panel (or under a parent tab)
sidebery-cli tab create https://example.com --panel "Research" --color green
sidebery-cli tab create https://a.com https://b.com --panel <panelId> --color blue
sidebery-cli tab create https://docs.example.com --parent <tabId> --discarded --title "Docs"

# Group existing tabs under a named, colored group tab
sidebery-cli tab group <tabId1> <tabId2> --title "Docs" --color turquoise

# Move tabs to another panel, parent tab, or index
sidebery-cli tab move <tabId1> <tabId2> --panel <id|name>
sidebery-cli tab move <tabId1> --parent <parentTabId>

# Flatten tab tree hierarchy
sidebery-cli tab flatten <tabId1> <tabId2>

# Set or reset tab custom color (omit tabIds to target the active tab)
sidebery-cli tab color red <tabId1> <tabId2>
sidebery-cli tab color reset <tabId1>

# Set custom title, activate, or close tabs
sidebery-cli tab title <tabId> "Custom Label"
sidebery-cli tab activate <tabId>
sidebery-cli tab close <tabId1> <tabId2>
```

Valid colors: `blue`, `turquoise`, `green`, `yellow`, `orange`, `red`, `pink`, `purple`, and `toolbar` / `none` / `reset` / `clear` to remove custom color.

## 5. Local HTTP / Unix-Socket API Fallback

If calling the local API directly instead of `sidebery-cli`, read the runtime discovery file (`$XDG_RUNTIME_DIR/sidebery-api.json` on Linux, `$TMPDIR/sidebery-api.json` on macOS, `%TEMP%\sidebery-api.json` on Windows) for `{ host, port, socket }`:

- `GET /api/health`, `GET /api/state`, `GET /api/windows`, `GET /api/panels`, `GET /api/tabs`, `GET /api/groups`
- `POST /api/panels`, `PATCH /api/panels/:id`, `DELETE /api/panels/:id`, `POST /api/panels/:id/activate`
- `POST /api/tabs`, `POST /api/tabs/group`, `POST /api/tabs/flatten`, `POST /api/tabs/move`, `POST /api/tabs/color`, `POST /api/tabs/title`, `POST /api/tabs/:id/activate`, `POST /api/tabs/close`
- `POST /api/rpc` with `{ "method": "...", "params": { ... } }`

Note: TCP requests from browser origins (`Origin` / cross-site `Sec-Fetch-Site`) are rejected with `403`.

## Best Practices for Agents

- Prefer panel IDs over names if multiple panels share a name.
- Check `sidebery-cli panels` / `sidebery-cli tabs --tree` before creating duplicate panels or closing tabs.
- Only close user tabs (`tab close` or `panel delete --tabs-mode close`) when the user requested cleanup or for temporary tabs you created.
