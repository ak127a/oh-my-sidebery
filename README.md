<div align="center">

# oh-my-sidebery

Firefox sidebar tab & bookmark manager — a fork of [Sidebery](https://github.com/mbnuqw/sidebery) with custom tab-color keybindings, an AI agent CLI (`sidebery-cli`), a local HTTP / Unix-socket API, and an AI agent skill.

</div>

<br>

<div align="center">

<img src="docs/assets/screenshot-003.png" width="20%" alt="screenshot-003" title="Firefox theme: Modern Light"><img src="docs/assets/screenshot-002.png" width="20%" alt="screenshot-002" title="Firefox theme: Arc Dark Theme"><img src="docs/assets/screenshot-005.png" width="20%" alt="screenshot-005" title="Firefox theme: Modern Light"><img src="docs/assets/screenshot-009.png" width="20%" alt="screenshot-009" title="Firefox theme: Vampyric Dark"><img src="docs/assets/screenshot-011.png" width="20%" alt="screenshot-011" title="Firefox theme: Modern Light">

</div>

## What `oh-my-sidebery` Adds

`oh-my-sidebery` extends upstream Sidebery with two extra features:

1. **Custom Keybinds for Tab Colors**
   - Adds customizable keybindings for all 8 Sidebery tab colors (`blue`, `turquoise`, `green`, `yellow`, `orange`, `red`, `pink`, `purple`) plus a color reset command (`toolbar`) in **Sidebery Settings → Keybindings → Colorize tabs**, complete with color swatch previews.
   - Applies to the currently selected tabs or the active tab when no selection is active.

2. **AI Agent CLI (`sidebery-cli`), Local HTTP / Unix-Socket API & Agent Skill**
   - Bridges a local CLI and loopback HTTP / Unix-socket API to `oh-my-sidebery` via Firefox Native Messaging (`sidebery_api`) so AI agents and scripts can:
     - **Inspect** open windows, panels, tabs, tree hierarchies, tab groups, custom colors, and URLs (`sidebery-cli tabs --tree`, `state`, `panels`, `groups`).
     - **Mutate** browser workspace state: create/update/switch/delete panels, open single or batch tabs in specific panels or under parent tabs, group/flatten/move tabs, retitle/activate/close tabs, and set/reset tab colors.
   - Ships with a ready-to-use AI agent skill ([skills/sidebery/SKILL.md](skills/sidebery/SKILL.md)).

## Setup

### CLI, Native Host & AI Skill (macOS / Linux / Windows)

Install the global `sidebery-cli` command, the Firefox native messaging host manifest (`sidebery_api`), and the `sidebery` AI skill in a **single command**:

**Without cloning (via `npx`):**
```sh
npx --yes github:ak127a/oh-my-sidebery install
```

**From a cloned repository:**
```sh
npm run setup:cli
```

<details><summary><b>What the single-command installer sets up on macOS, Linux, and Windows</b></summary>

- **Linux**: Installs self-contained scripts to `~/.local/share/sidebery-api`, `sidebery-cli` to `~/.local/bin/sidebery-cli`, and `sidebery_api.json` to `~/.mozilla/native-messaging-hosts/` and `~/.config/mozilla/native-messaging-hosts/`.
- **macOS**: Installs self-contained scripts to `~/.local/share/sidebery-api`, `sidebery-cli` to `~/.local/bin/sidebery-cli`, and `sidebery_api.json` to `~/Library/Application Support/Mozilla/NativeMessagingHosts/`.
- **Windows**: Installs self-contained scripts to `%LOCALAPPDATA%\sidebery-api`, `sidebery-cli.cmd` to `%APPDATA%\npm` (or `%USERPROFILE%\.local\bin`), and registers `HKCU\Software\Mozilla\NativeMessagingHosts\sidebery_api`.
- **AI Skill**: Copies [skills/sidebery/SKILL.md](skills/sidebery/SKILL.md) to `~/.agents/skills/sidebery/SKILL.md` and any detected agent skill directories (`~/.claude`, `~/.codex`, `~/.gemini/config`, `~/.cursor`).
- **Uninstall**: Run `sidebery-cli uninstall` (or `npm run uninstall:cli`).

</details>

### Build & Load the Extension

> Prerequisites: latest LTS Node.js version

```sh
npm ci
npm run build
# Optional: package a .zip archive in ./dist
npm run build.ext
```

Then in Firefox:
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `addon/manifest.json` (or the `.zip` file in `./dist`)

### Quick CLI Usage

```sh
sidebery-cli ping
sidebery-cli tabs --tree
sidebery-cli panel create "Research" --color purple --icon icon_search --activate
sidebery-cli tab create https://example.com --panel "Research" --color green
sidebery-cli tab group 12 13 --title "Docs" --color turquoise
sidebery-cli tab color red 12
```

See [docs/agent-api.md](docs/agent-api.md) for the full CLI & HTTP API reference and [skills/sidebery/SKILL.md](skills/sidebery/SKILL.md) for the AI agent skill instructions.

## About

`oh-my-sidebery` retains all core sidebar capabilities from upstream Sidebery:

- Vertical tabs panels with tree or flat layout
- Bookmarks panels
- History panel
- Search in panels
- Customizable context menu
- Customizable styles
- Snapshots (saved windows/panels/tabs)
- ...and more

## Incompatibility with other addons

`oh-my-sidebery` may conflict with addons that handle the position of new tabs (e.g. Tree Style Tabs) or addons that move/sort tabs, which may result in unexpected behavior or broken tabs state at initialization. To avoid potential issues, please disable such addons in the Add-ons Manager page (`about:addons`).

## How to hide native tabs?

<details><summary><b> Option 1 (Activating native vertical tabs) </b></summary>

Enable native vertical tabs. This can be done in one of the following ways:
- Right-click on the free space of the toolbar or tab-bar and click on the "Turn on Vertical Tabs".
- Open `about:config` and enable these settings: `sidebar.revamp`, `sidebar.verticalTabs`.

Then resize the native sidebar (with the vertical tabs) to its minimum.

Optionally, you can round the corner of the web page area by enabling `sidebar.revamp.round-content-area` in `about:config`.

<img width="940" alt="gui" src="https://github.com/user-attachments/assets/b7d04c1c-1d23-48d6-a802-92d228f44f06" />

This will save vertical space, but the native tabs will still be showed and Firefox's sidebar header will take some space from Sidebery.

You can also try to hide vertical native tabs and sidebar: Right-click on the free space of the native sidebar, then in the "Sidebar settings" section enable "Vertical tabs" and "Hide tabs and sidebar" settings, then open Sidebery. But due to [a Firefox bug](https://bugzilla.mozilla.org/show_bug.cgi?id=1962904) this setting might be ignored on the next browser start or on the opening a new window.

</details>

<details><summary><b> Option 2 (Using userChrome.css) </b></summary>

- Learn how to [comment/uncomment](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Syntax/Comments) parts of your CSS.
- Enable `toolkit.legacyUserProfileCustomizations.stylesheets` in `about:config`.
- In 'Profile Directory' `(Firefox Menu > Help > Troubleshooting Information > Profile Directory)`
create folder `chrome` with file `userChrome.css`.
- Paste, edit (to your needs) and save this code in `userChrome.css` file:

  ```css
  /**
  * Hide sidebar-panel-header (sidebar.revamp: true)
  */
  #sidebar-panel-header {
    display: none;
  }

  /**
  * Dynamic styles
  *
  * Choose when styles below will be activated (comment/uncomment line)
  * - When Sidebery set title preface "."
  * - When Sidebery sidebar is active
  */
  #main-window[titlepreface="."] {
  /* #main-window:has(#sidebar-box[sidebarcommand="_3c078156-979c-498b-8990-85f7987dd929_-sidebar-action"][checked="true"]) { */

    /* Hide horizontal native tabs toolbar */
    #TabsToolbar > * {
      display: none !important;
    }

    /* Hide top window border */
    #nav-bar {
      border-color: transparent !important;
    }

    /* Hide new Firefox sidebar, restyle addon's sidebar */
    #sidebar-main, #sidebar-container, #sidebar-launcher-splitter {
      display: none !important;
    }
    #sidebar-box {
      padding: 0 !important;
      border-radius: 0 !important;
      border: none !important;
    }
    #sidebar-box #sidebar {
      box-shadow: none !important;
      border: none !important;
      outline: none !important;
      border-radius: 0 !important;
    }
    #sidebar-splitter {
      --splitter-width: 3px !important;
      min-width: var(--splitter-width) !important;
      width: var(--splitter-width) !important;
      padding: 0 !important;
      margin: 0 calc(-1*var(--splitter-width) + 1px) 0 0 !important;
      border: 0 !important;
      opacity: 0 !important;
    }

    /* Update background color of the #browser area (it's visible near the
    rounded corner of the web page) so it blends with sidebery color with 
    vertical nav-bar. */
    /* #browser {
      background-color: var(--lwt-accent-color) !important;
      background-image: none !important;
    } */

    /* Hide sidebar header (sidebar.revamp: false) */
    #sidebar-header {
      display: none !important;
    }

    /* Uncomment the block below to show window buttons in Firefox nav-bar 
    (maybe, I didn't test it on non-linux-tiled-wm env) */
    /* #nav-bar > .titlebar-buttonbox-container,
    #nav-bar > .titlebar-buttonbox-container > .titlebar-buttonbox {
      display: flex !important;
    } */

    /* Uncomment one of the lines below if you need space near window buttons */
    /* #nav-bar > .titlebar-spacer[type="pre-tabs"] { display: flex !important; } */
    /* #nav-bar > .titlebar-spacer[type="post-tabs"] { display: flex !important; } */
  }
  ```

- Restart the browser
- Optionally, try to turn on/off native vertical tabs to know how it changes the color of the browser toolbar.

Result:

<img width="947" alt="111" src="https://github.com/user-attachments/assets/2f1532dd-aac1-41bb-9dfa-7d025a085ac1" />

- Optionally, add some bells and whistles (add to Sidebery styles editor):

  <details><summary>Rounded corner for vertical nav bar</summary>

  ```css
  /* Do not apply the border from Firefox theme */
  .Notifications + .main-box .central-box {
    height: calc(100% - var(--general-margin));
    margin-top: var(--general-margin);
  }
  .NavigationBar {
    box-shadow: none;
  }
  .NavigationBar.-vert {
    padding: var(--nav-btn-margin) 0 0
  }
  #root[data-pinned-tabs-position="left"]:not([data-nav-layout="horizontal"]) .PinnedTabsBar,
  #root[data-pinned-tabs-position="right"]:not([data-nav-layout="horizontal"]) .PinnedTabsBar {
    padding: var(--general-margin) 0 calc(var(--tabs-margin) * 2);
  }
  #root[data-pinned-tabs-position="left"][data-nav-layout="left"][data-drag="true"] .PinnedTabsBar,
  #root[data-pinned-tabs-position="right"][data-nav-layout="right"][data-drag="true"] .PinnedTabsBar {
    padding: var(--general-margin) 0 16px
  }

  /* Rounded transition between Sidebery nav-bar and Firefox toolbar */
  .main-box {
    --rounding: calc(var(--general-border-radius) + var(--general-margin));
  }
  #root[data-nav-layout="left"] .main-box:before {
    content: '';
    position: absolute;
    top: 0;
    left: var(--nav-btn-width);
    width: var(--rounding);
    height: var(--rounding);
    z-index: 1000;
    pointer-events: none;
    background-image: radial-gradient(
      circle at 100% 100%,
      #00000000,
      #00000000 var(--rounding),
      var(--toolbar-bg) calc(var(--rounding) + 0.5px),
      var(--toolbar-bg)
    );
  }
  ```

  <img width="214" alt="222" src="https://github.com/user-attachments/assets/d605e088-d66b-450e-aab3-36a727e91feb" />

  </details>  

  <details><summary>Full width pinned tabs</summary>

  ```css
  #root.root {--tabs-pinned-height: 32px;}
  #root.root {--tabs-pinned-width: 36px;}

  #root.root .PinnedTabsBar .tab-wrapper {
    width: auto;
    flex-grow: 1;
  }
  #root.root .PinnedTabsBar .tab-wrapper .Tab {
    --tabs-activated-shadow: inset 0 0 0 1px #fff2;
    --tabs-activated-bg: #fff2;
    width: 100%;
    min-width: var(--tabs-pinned-width);
  }
  #root.root .PinnedTabsBar .tab-wrapper .Tab .body {
    --tabs-normal-bg: #ffffff0f;
  }
  #root.root .PinnedTabsBar .tab-wrapper .Tab[data-discarded="true"] .body {
    --tabs-normal-bg: #ffffff06;
  }
  ```

  <img width="403" height="364" alt="screenshot-2025-11-11 23-45-26" src="https://github.com/user-attachments/assets/001b87a0-ad0d-41f4-aa10-e698d725672c" />

  </details>  
  <br/>

  For more styling options and themes, check out these community resources:

  - https://github.com/search?q=sidebery+language%3ACSS&type=repositories&s=stars&o=desc
  - https://www.reddit.com/r/FirefoxCSS/search?q=sidebery&restrict_sr=on&sort=relevance&t=all
  - https://trickypr.github.io/FirefoxCSS-Store.github.io/index.html

</details>

## Development

> Prerequisites: latest LTS Node.js version

```sh
npm install
npm run dev
npm run dev.run -- <firefox-executable>
```

Run tests:

```sh
npm run test
npm run test.cli
```

## Credits

`oh-my-sidebery` is a fork of [Sidebery](https://github.com/mbnuqw/sidebery) by [mbnuqw](https://github.com/mbnuqw). To support upstream Sidebery development, see upstream's [DONATE.md](https://github.com/mbnuqw/sidebery/blob/v5/DONATE.md).

## License

[MIT](./LICENSE)
