# pen2figma

Bring [Pen](https://pen.dev) designs into Figma as real, editable layers: auto-layout, text, components, images, icons and color variables.

![Choosing frames](docs/screenshots/plugin-pick-frames.png)

## Install (once, about 2 minutes)

You need an Apple Silicon Mac with the **Pen** app and the **Figma desktop app**.

1. Download [pen2figma.zip](https://github.com/SheroCommerce/pen2figma-releases/archive/refs/heads/main.zip) and unzip it.
2. Double-click **`Install.command`**. A Terminal window runs for a few seconds and ends with *Done*.
   - *Can't verify the developer?* Click **Done**, open **System Settings → Privacy & Security**, click **Open Anyway** next to *Install.command*, and confirm.
   - *Node.js missing?* The installer opens nodejs.org. Install the **LTS** version, then double-click `Install.command` again.
3. A Finder window opens with **`manifest.json`** selected. In Figma, go to **Plugins → Development → Import plugin from manifest…** and drag it in.

You can delete the downloaded folder afterwards.

## Use

1. Open your design in **Pen**. Select the frames you want, or nothing to get them all.
2. In **Figma**, open **Plugins → Development → pen2figma**.
3. Tick the frames to bring over (Shift-click ticks a range), then click **Import**.

![After an import](docs/screenshots/plugin-done.png)

Anything that needs a look, like a font you don't have, is listed under the result. Frames land where they sit in Pen, so an empty page works best.

## Update

Click **Check for updates** at the bottom of the plugin, then **Update**, then close and reopen the plugin.

## Problems

![Helper offline](docs/screenshots/plugin-offline.png)

- **pen2figma isn't running:** double-click `Install.command` again, then **Try again**.
- **Fonts replaced with Inter:** install the font on your Mac and import again.
- **Import failed** or anything else: click **Copy details** (or take a screenshot) and send it to whoever maintains pen2figma.

To remove it, double-click `Uninstall.command`, then remove the plugin under **Plugins → Development → Manage plugins in development**.

---

## For developers

A Node helper (`bin/pen2figma.mjs serve`, run at login by launchd on `localhost:4141`) reads the open Pen document through Pen's MCP server. The Figma plugin (`plugin/`) asks it for frames and rebuilds them as native nodes; no LLM runs in the loop. `Install.command` copies everything to `~/Library/Application Support/pen2figma` (log: `/tmp/pen2figma.log`).

- **Ship an update:** bump `version` in `package.json` and `VERSION` in `plugin/ui.html` (`npm run check` keeps them in step), then merge to `main`. `.github/workflows/release.yml` mirrors the installable files to the public [`pen2figma-releases`](https://github.com/SheroCommerce/pen2figma-releases), which is where installs and *Check for updates* download from.
- **From a clone:** `npm install`, then `node bin/pen2figma.mjs serve`, or `install` / `uninstall` to manage the launchd agent.
- **Without the helper:** `node bin/pen2figma.mjs export` writes `out/<doc>/design.json` and `assets/`; import them with **Import from files** in the plugin.

`AGENTS.md` covers the data contract, conventions and gotchas.
