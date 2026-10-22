#!/usr/bin/env node
// pen2figma — move pen.dev designs into Figma. No LLM involved.
//
//   pen2figma export [nodeId ...] [--doc <file.pen>] [--out <dir>] [--no-icons]
//       dump nodes to out/<doc>/design.json + assets/ for the plugin's file picker
//       (no nodeIds → current selection in Pen, else all top-level nodes)
//   pen2figma serve [--port 4141]
//       local helper the Figma plugin talks to, so designers never touch this CLI
//   pen2figma install | uninstall
//       run `serve` at login through launchd

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withPen, getState, exportNodes } from "../lib/pen.mjs";

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));
const { version: VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const DEFAULT_PORT = 4141;
const LAUNCHD_LABEL = "com.shero.pen2figma";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
// public mirror of main, published by .github/workflows/release.yml; the code repo itself stays private
const REPO = "SheroCommerce/pen2figma-releases";

function parseArgs(argv) {
  const a = { ids: [], doc: null, out: null, icons: true, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--doc") a.doc = argv[++i];
    else if (v === "--out") a.out = argv[++i];
    else if (v === "--port") a.port = Number(argv[++i]);
    else if (v === "--no-icons") a.icons = false;
    else if (v.startsWith("--")) throw new Error(`unknown flag ${v}`);
    else a.ids.push(v);
  }
  return a;
}

function pickIds(state, requested) {
  const ids = requested.length ? requested : (state.selected.length ? state.selected : state.top).map((n) => n.id);
  if (!ids.length) throw new Error("nothing to export: no selection and no top-level nodes");
  return ids;
}

async function cmdExport(args) {
  await withPen(async (client) => {
    const state = await getState(client);
    const doc = args.doc ? resolve(args.doc) : state.doc;
    if (!doc) throw new Error("no .pen document open in Pen and none passed with --doc");
    const ids = pickIds(state, args.ids);
    console.error(`doc: ${doc}\nnodes: ${ids.join(", ")}`);

    const { design, assetBytes, missingAssets, missingIcons, missingRasters, nodeCount } = await exportNodes(client, { doc, ids, icons: args.icons });
    const out = resolve(args.out || join("out", design.name));
    mkdirSync(join(out, "assets"), { recursive: true });
    for (const [url, bytes] of Object.entries(assetBytes)) {
      const dst = join(out, "assets", url);
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, bytes);
    }
    writeFileSync(join(out, "design.json"), JSON.stringify(design));

    console.error(`wrote ${join(out, "design.json")}\n  nodes: ${nodeCount}  assets: ${design.assets.length - missingAssets.length}/${design.assets.length}  icons: ${Object.keys(design.icons).length}/${Object.keys(design.icons).length + missingIcons.length}`);
    if (missingAssets.length) console.error(`  missing assets: ${missingAssets.join(", ")}`);
    if (missingIcons.length) console.error(`  missing icons (will import as empty frames): ${missingIcons.join(", ")}`);
    if (missingRasters.length) console.error(`  could not export as image (will import as empty frames): ${missingRasters.join(", ")}`);
    process.stdout.write(`${out}\n`);
  });
}

// "0.10.0" is newer than "0.9.1"
function isNewer(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function latestVersion() {
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/package.json`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`can't reach updates on GitHub (HTTP ${r.status})`);
  return (await r.json()).version;
}

// Replaces this install with the latest release, the same way Install.command copies a downloaded folder.
async function installLatest() {
  if (existsSync(join(ROOT, ".git"))) throw new Error("this helper runs from a git clone; update it with git pull");
  const r = await fetch(`https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`can't download the update from GitHub (HTTP ${r.status})`);
  const tmp = mkdtempSync(join(tmpdir(), "pen2figma-"));
  try {
    const src = join(tmp, "src");
    mkdirSync(src);
    writeFileSync(join(tmp, "main.tar.gz"), Buffer.from(await r.arrayBuffer()));
    execFileSync("tar", ["-xzf", join(tmp, "main.tar.gz"), "-C", src, "--strip-components", "1"]);
    const { version } = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
    execFileSync("rsync", ["-a", "--delete", "--exclude", ".git", "--exclude", ".claude", "--exclude", "node_modules", "--exclude", "out", `${src}/`, `${ROOT}/`]);
    // launchd starts the helper with a bare PATH; npm needs the node it ships with
    const bin = dirname(process.execPath);
    execFileSync(join(bin, "npm"), ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}` } });
    return version;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// GET /state            → { version, doc, selected: [{id,type,name}], top: [...] }
// GET /export?ids=a,b   → design.json shape + assetData: { url: base64 }; ids omitted → selection, else top-level
// GET /update           → { version, latest, available }: compares this install with the releases repo
// POST /update          → { version }: installs the latest release, then exits so launchd restarts the helper on the new code
function cmdServe(args) {
  // Pen accepts one pen2figma connection at a time; overlapping ones stall until the MCP timeout.
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));
  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/state") {
        return json(res, 200, { version: VERSION, ...(await serial(() => withPen(getState))) });
      }
      if (url.pathname === "/export") {
        const requested = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
        const body = await serial(() => withPen(async (client) => {
          const state = await getState(client);
          if (!state.doc) throw new Error("no .pen document open in Pen");
          const ids = pickIds(state, requested);
          const r = await exportNodes(client, { doc: state.doc, ids, icons: true });
          const assetData = {};
          for (const [k, v] of Object.entries(r.assetBytes)) assetData[k] = v.toString("base64");
          return { ...r.design, assetData, missingAssets: r.missingAssets, missingIcons: r.missingIcons, missingRasters: r.missingRasters, nodeCount: r.nodeCount };
        }));
        return json(res, 200, body);
      }
      if (url.pathname === "/update") {
        if (req.method === "POST") {
          // queued so files aren't swapped under a running export
          const version = await serial(installLatest);
          json(res, 200, { version });
          return setTimeout(() => process.exit(0), 200);
        }
        const latest = await latestVersion();
        return json(res, 200, { version: VERSION, latest, available: isNewer(latest, VERSION) });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 503, { error: e.message });
    }
  });
  server.listen(args.port, "127.0.0.1", () => console.error(`pen2figma helper on http://localhost:${args.port}`));
}

function cmdInstall() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${SELF}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/pen2figma.log</string>
</dict></plist>
`;
  mkdirSync(dirname(PLIST), { recursive: true });
  if (existsSync(PLIST)) execFileSync("launchctl", ["unload", PLIST]);
  writeFileSync(PLIST, plist);
  execFileSync("launchctl", ["load", PLIST]);
  console.error(`installed ${PLIST}\nhelper runs at login on http://localhost:${DEFAULT_PORT} (log: /tmp/pen2figma.log)`);
}

function cmdUninstall() {
  if (!existsSync(PLIST)) return console.error("not installed");
  execFileSync("launchctl", ["unload", PLIST]);
  unlinkSync(PLIST);
  console.error(`removed ${PLIST}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === "export") return cmdExport(args);
  if (cmd === "serve") return cmdServe(args);
  if (cmd === "install") return cmdInstall();
  if (cmd === "uninstall") return cmdUninstall();
  console.error("usage: pen2figma export [nodeId ...] [--doc <file.pen>] [--out <dir>] [--no-icons]\n       pen2figma serve [--port 4141]\n       pen2figma install | uninstall");
  process.exit(2);
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
