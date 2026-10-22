// Talks to the Pen desktop app through its bundled MCP server and turns a set of nodes
// into the design.json contract the Figma plugin consumes. No LLM involved.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const PEN_MCP = "/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64";
const HERE = dirname(fileURLToPath(import.meta.url));
const ICON_CACHE = join(homedir(), ".pen2figma", "icons");
const ICON_SOURCES = {
  lucide: (n) => [
    `https://cdn.jsdelivr.net/npm/lucide-static/icons/${n}.svg`,
    `https://unpkg.com/lucide-static/icons/${n}.svg`,
  ],
  phosphor: (n) => [
    `https://cdn.jsdelivr.net/npm/@phosphor-icons/core/assets/regular/${n}.svg`,
    `https://unpkg.com/@phosphor-icons/core/assets/regular/${n}.svg`,
  ],
  tabler: (n) => [`https://cdn.jsdelivr.net/npm/@tabler/icons/icons/outline/${n}.svg`],
  feather: (n) => [`https://cdn.jsdelivr.net/npm/feather-icons/dist/icons/${n}.svg`],
};
for (const style of ["Outlined", "Rounded", "Sharp"]) {
  ICON_SOURCES[`Material Symbols ${style}`] = (n, w) => [
    `https://cdn.jsdelivr.net/npm/@material-symbols/svg-${w}/${style.toLowerCase()}/${n}.svg`,
    `https://unpkg.com/@material-symbols/svg-${w}/${style.toLowerCase()}/${n}.svg`,
  ];
}

// Material Symbols ship one SVG set per weight (100-700); other libraries have a single weight.
// Mirrored in plugin/code.js.
export function iconKey(n) {
  const lib = n.library || "lucide";
  if (!lib.startsWith("Material Symbols")) return { key: `${lib}/${n.icon}`, lib, name: n.icon, weight: null };
  const weight = Math.min(700, Math.max(100, Math.round((typeof n.weight === "number" ? n.weight : 400) / 100) * 100));
  return { key: `${lib}/${n.icon}@${weight}`, lib, name: n.icon, weight };
}

// Nodes Figma can't rebuild natively. They're exported from Pen as PNG and placed as images.
const RASTER_TYPES = new Set(["browser", "script", "note", "prompt", "context"]);
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
function needsRaster(n) {
  return RASTER_TYPES.has(n.type)
    || list(n.fill).some((f) => f && (f.type === "shader" || f.type === "mesh_gradient"))
    || list(n.effect).some((e) => e && e.type === "shader");
}

function text(res) {
  return (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

function printOutput(s) {
  const m = s.split("## Print output\n")[1];
  if (!m) throw new Error(`pen execute returned no Print output:\n${s.slice(0, 500)}`);
  return m.trim().split("\n")[0];
}

// `ySsMU` (frame): Phase 3 – Selecting (Desktop) [user visible], `z07Kc9` (frame): Entry Card [user visible]
function parseNodeList(line) {
  return [...line.matchAll(/`([A-Za-z0-9]+)` \(([a-z_]+)\): (.*?)(?: \[[^\]]*\])?(?=, `|$)/g)]
    .map((m) => ({ id: m[1], type: m[2], name: m[3] }));
}

export function parseAppState(s) {
  const doc = s.match(/Currently active canvas editor: `([^`]+)`/)?.[1] || null;
  const selected = parseNodeList(s.match(/Selected nodes: (.*)/)?.[1] || "");
  const top = parseNodeList(s.match(/Top-level nodes: (.*)/)?.[1] || "");
  return { doc, selected, top };
}

export function walk(n, fn) {
  fn(n);
  for (const c of n.children || []) walk(c, fn);
}

async function fetchIcon(lib, name, weight) {
  const file = weight ? `${name}@${weight}.svg` : `${name}.svg`;
  const cached = join(ICON_CACHE, lib, file);
  const bundled = join(HERE, "..", "icons", lib, file);
  for (const p of [cached, bundled]) if (existsSync(p)) return readFileSync(p, "utf8");
  const urls = ICON_SOURCES[lib]?.(name, weight);
  if (!urls) return null;
  for (const u of urls) {
    try {
      // jsdelivr sometimes takes minutes to answer an uncached file; move on to the next mirror instead
      const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      // lucide-static prefixes a license comment; keep only the <svg> element.
      const svg = (await r.text()).replace(/^[\s\S]*?(?=<svg[\s>])/, "").trim();
      if (!svg.startsWith("<svg")) continue;
      mkdirSync(dirname(cached), { recursive: true });
      writeFileSync(cached, svg);
      return svg;
    } catch {}
  }
  return null;
}

// Runs fn(client) against a fresh connection to the Pen app, always closing it after.
// Pen occasionally stops answering a connection mid-session (cause unknown); a fresh connection recovers.
// Normal calls finish in under 2 s, so give up after 20 s and retry once on a new connection.
const CALL_TIMEOUT = 20000;

async function connect() {
  const transport = new StdioClientTransport({ command: PEN_MCP, args: ["--app", "desktop", "--agent", "pen2figma"], stderr: "ignore" });
  const client = new Client({ name: "pen2figma", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (e) {
    throw new Error(`could not reach the Pen app. Is Pen open? (${e.message})`);
  }
  return client;
}

export async function withPen(fn) {
  if (!existsSync(PEN_MCP)) throw new Error(`Pen app not found at ${PEN_MCP}`);
  let client = await connect();
  const pen = {
    async callTool(req) {
      try {
        return await client.callTool(req, undefined, { timeout: CALL_TIMEOUT });
      } catch (e) {
        if (e.code !== -32001) throw e; // McpError RequestTimeout
        await client.close().catch(() => {});
        client = await connect();
        return await client.callTool(req, undefined, { timeout: CALL_TIMEOUT });
      }
    },
  };
  try {
    return await fn(pen);
  } finally {
    await client.close();
  }
}

async function exec(client, doc, script) {
  const raw = text(await client.callTool({ name: "execute", arguments: { filePath: doc, input: script } }));
  if (!raw.startsWith("OK")) throw new Error(`pen execute failed:\n${raw.slice(0, 800)}`);
  return raw;
}

async function run(client, doc, script) {
  return JSON.parse(printOutput(await exec(client, doc, script)));
}

export async function getState(client) {
  const state = parseAppState(text(await client.callTool({ name: "get_app_state", arguments: {} })));
  // get_app_state truncates "Top-level nodes" after 10 ("... +25 others"), so list them from the document.
  if (state.doc) state.top = await run(client, state.doc, `Print(JSON.stringify(Get((n,c)=>{c.skipChildren();return {id:n.id,type:n.type,name:n.name}})))`);
  return state;
}

// Returns { design, assetBytes: { url: Buffer }, missingAssets, missingIcons, missingRasters, nodeCount }.
export async function exportNodes(client, { doc, ids, icons = true }) {
  // One execute per node: each call gets its own MCP timeout instead of the whole export sharing one.
  const { variables, themes } = await run(client, doc, `Print(JSON.stringify(GetVariables()))`);
  const data = { vars: variables, nodes: [] };
  const resolved = (id) => run(client, doc, `Print(JSON.stringify(Get(${JSON.stringify(id)},{depth:200,resolveInstances:true,includePathGeometry:true})))`);
  // The resolved tree drops which component an instance came from. Read the unresolved tree's `ref` nodes:
  // their id matches the instance root in the resolved tree, `descendants` holds the overrides.
  const refsOf = (id) => run(client, doc, `Print(JSON.stringify(Get(${JSON.stringify(id)},(n)=>n.type==="ref"?{id:n.id,ref:n.ref,descendants:n.descendants||{}}:undefined)))`);
  for (const id of ids) data.nodes.push(await resolved(id));

  // Components used by the selection but not part of it are exported too, so instances can link to them.
  const refs = {};
  const components = [];
  const known = new Set(ids);
  const queue = [...ids];
  while (queue.length) {
    const id = queue.shift();
    let found;
    try { found = await refsOf(id); } catch { continue; } // e.g. a component from an imported .pen file
    for (const r of found) {
      refs[r.id] = { ref: r.ref, descendants: r.descendants };
      if (known.has(r.ref)) continue;
      known.add(r.ref);
      try { components.push(await resolved(r.ref)); queue.push(r.ref); } catch {}
    }
  }

  const assets = new Set();
  const iconRefs = new Map();
  const rasterIds = [];
  let nodeCount = 0;
  for (const n of [...data.nodes, ...components]) walk(n, (x) => {
    nodeCount++;
    if (needsRaster(x)) rasterIds.push(x.id);
    const fills = Array.isArray(x.fill) ? x.fill : [x.fill];
    for (const f of fills) if (f && typeof f === "object" && f.type === "image" && f.url) assets.add(f.url);
    if (x.type === "icon" && x.icon) { const k = iconKey(x); iconRefs.set(k.key, k); }
  });

  const docDir = dirname(doc);
  const assetBytes = {};
  const missingAssets = [];
  for (const url of assets) {
    const src = join(docDir, url);
    if (/^https?:/.test(url) || !existsSync(src)) { missingAssets.push(url); continue; }
    assetBytes[url] = readFileSync(src);
  }

  // Export each raster node into its own folder: Pen names files after the last id segment,
  // so two instances of one component would otherwise overwrite each other.
  const rasters = {};
  const missingRasters = [];
  const tmp = mkdtempSync(join(tmpdir(), "pen2figma-"));
  try {
    for (const [i, id] of rasterIds.entries()) {
      const dir = join(tmp, String(i));
      try {
        await exec(client, doc, `Export(${JSON.stringify([id])},"png",${JSON.stringify(dir)},{scale:2})`);
        const png = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".png"))));
        const url = `raster/${i}.png`;
        assetBytes[url] = png;
        assets.add(url);
        // PNG IHDR: width and height are big-endian uint32 at bytes 16 and 20; exported at 2x.
        rasters[id] = { url, width: png.readUInt32BE(16) / 2, height: png.readUInt32BE(20) / 2 };
      } catch { missingRasters.push(id); }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const iconSvgs = {};
  const missingIcons = [];
  if (icons) {
    for (const { key, lib, name, weight } of iconRefs.values()) {
      const svg = await fetchIcon(lib, name, weight);
      if (svg) iconSvgs[key] = svg; else missingIcons.push(key);
    }
  }

  const design = {
    name: basename(doc, ".pen"),
    source: doc,
    exportedAt: new Date().toISOString(),
    vars: data.vars,
    themes: themes || null,
    nodes: data.nodes,
    components,
    refs,
    icons: iconSvgs,
    rasters,
    assets: [...assets],
  };
  return { design, assetBytes, missingAssets, missingIcons, missingRasters, nodeCount };
}
