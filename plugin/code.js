// pen2figma — Figma plugin main thread. Rebuilds a pen.dev node tree (design.json from `pen2figma export`)
// as native Figma nodes: auto-layout frames, text, vectors, image fills, color variables.
// Plain JS, no build step. Runs entirely inside Figma; no network.

figma.showUI(__html__, { width: 380, height: 520 });

const log = (text) => figma.ui.postMessage({ type: "log", text });

figma.ui.onmessage = async (msg) => {
  if (msg.type !== "import") return;
  try {
    const summary = await importDesign(msg.design, msg.assets);
    figma.ui.postMessage({ type: "done", ok: true, text: summary });
  } catch (e) {
    figma.ui.postMessage({ type: "done", text: `failed: ${e.message}\n${e.stack || ""}` });
    throw e;
  }
};

async function importDesign(design, assets) {
  const ctx = {
    vars: design.vars || {},
    themes: design.themes || {},
    theme: {},
    icons: design.icons || {},
    rasters: design.rasters || {},
    refs: design.refs || {},
    defs: {},
    comps: {},
    defBuilding: new Set(),
    rootIds: new Set(design.nodes.map((n) => n.id)),
    detached: new Set(),
    assets,
    imageSizes: {},
    pendingCrops: [],
    varNodes: {},
    imageHashes: {},
    fontStyles: null,
    fontCache: {},
    missingFonts: new Set(),
    missingImages: new Set(),
    missingIcons: new Set(),
    unknownTypes: new Set(),
    skipped: new Set(),
    created: 0,
  };

  const all = [...design.nodes, ...(design.components || [])];
  // every reusable node can be a component; instance roots in the resolved tree carry path ids, so skip those
  const collect = (n) => { if (n.reusable && !n.id.includes("/")) ctx.defs[n.id] = n; for (const c of n.children || []) collect(c); };
  all.forEach(collect);

  await setupVariables(ctx, design.name);
  ctx.fontStyles = await listFontStyles();
  await preloadFonts(ctx, all);
  await preloadImageSizes(ctx, all);

  const roots = [];
  for (const n of design.nodes) {
    roots.push(n.reusable && ctx.defs[n.id] ? await ensureComponent(ctx, n.id) : await build(ctx, n, figma.currentPage));
    log(`built ${n.name || n.type}`);
  }
  if (ctx.area) {
    ctx.area.resize(ctx.areaSize.w, Math.max(1, ctx.areaSize.h - 80));
    ctx.area.x = Math.max(...roots.map((r) => r.x + r.width)) + 400;
    ctx.area.y = Math.min(...roots.map((r) => r.y));
    roots.push(ctx.area);
  }
  // Cropped images need the node's final size, which auto layout only settles once the tree is built.
  for (const { node, fill } of ctx.pendingCrops) node.fills = paints(ctx, fill, { w: node.width, h: node.height });
  figma.viewport.scrollAndZoomIntoView(roots);

  const lines = [`done: ${ctx.created} nodes, ${roots.length} root(s), ${Object.keys(ctx.comps).length} component(s)`];
  if (ctx.missingFonts.size) lines.push(`fonts not available (fell back to Inter): ${[...ctx.missingFonts].join(", ")}`);
  if (ctx.missingImages.size) lines.push(`images without bytes (grey placeholder): ${[...ctx.missingImages].join(", ")}`);
  if (ctx.missingIcons.size) lines.push(`icons without svg (empty frame): ${[...ctx.missingIcons].join(", ")}`);
  if (ctx.unknownTypes.size) lines.push(`unsupported pen types imported as frames: ${[...ctx.unknownTypes].join(", ")}`);
  if (ctx.skipped.size) lines.push(`not applied: ${[...ctx.skipped].join(", ")}`);
  if (ctx.detached.size) lines.push(`built as plain frames, not instances: ${[...ctx.detached].join("; ")}`);
  return lines.join("\n");
}

// ---------- variables ----------

const VAR_TYPES = { color: "COLOR", number: "FLOAT", string: "STRING", boolean: "BOOLEAN" };

async function setupVariables(ctx, designName) {
  const wanted = Object.entries(ctx.vars).filter(([, v]) => v && VAR_TYPES[v.type]);
  if (!wanted.length) return;
  const collName = `pen.dev/${designName}`;
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let coll = collections.find((c) => c.name === collName);
  const existing = {};
  if (coll) {
    for (const id of coll.variableIds) { const v = await figma.variables.getVariableByIdAsync(id); if (v) existing[v.name] = v; }
  } else coll = figma.variables.createVariableCollection(collName);
  // The first pen theme axis (e.g. mode: light/dark) becomes the collection's modes;
  // nodes with a `theme` switch mode explicitly. Other axes resolve to their default value.
  const axis = Object.keys(ctx.themes)[0];
  const values = axis ? ctx.themes[axis] : [];
  const modeIds = axis ? {} : { "": coll.modes[0].modeId };
  values.forEach((value, i) => {
    let m = coll.modes.find((x) => x.name === value);
    if (!m && i === 0) { coll.renameMode(coll.modes[0].modeId, value); m = coll.modes[0]; }
    if (!m) {
      try { m = { modeId: coll.addMode(value) }; } catch (e) { log(`theme mode "${value}" not created (${e.message}); using "${values[0]}"`); return; }
    }
    modeIds[value] = m.modeId;
  });
  // create every variable first so values can alias each other (`$other`)
  for (const [name, def] of wanted) {
    const type = VAR_TYPES[def.type];
    if (existing[name] && existing[name].resolvedType !== type) { log(`variable "${name}" exists with another type; left alone`); continue; }
    const v = existing[name] || figma.variables.createVariable(name, coll, type);
    if (type === "COLOR") v.scopes = ["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"];
    ctx.varNodes[name] = v;
  }
  for (const [name, def] of wanted) {
    const v = ctx.varNodes[name];
    if (!v) continue;
    for (const [value, modeId] of Object.entries(modeIds)) {
      const raw = resolveThemed(ctx, def.value, axis ? { [axis]: value } : {});
      const target = typeof raw === "string" && raw[0] === "$" && ctx.varNodes[raw.slice(1)];
      if (target) { v.setValueForMode(modeId, figma.variables.createVariableAlias(target)); continue; }
      if (def.type === "color") { const { color, opacity } = hex(raw); v.setValueForMode(modeId, { ...color, a: opacity }); }
      else if (def.type === "number") v.setValueForMode(modeId, Number(raw) || 0);
      else if (def.type === "boolean") v.setValueForMode(modeId, raw === true || raw === "true");
      else v.setValueForMode(modeId, String(raw));
    }
  }
  if (axis) { ctx.themeAxis = axis; ctx.themeColl = coll; ctx.themeModes = modeIds; }
  const counts = {};
  for (const [, d] of wanted) counts[d.type] = (counts[d.type] || 0) + 1;
  log(`variables in "${collName}": ${Object.entries(counts).map(([k, c]) => `${c} ${k}`).join(", ")}${axis ? `; modes: ${Object.keys(modeIds).join(", ")}` : ""}`);
}

// Pick the themed entry that matches the current theme best; unset axes use their first (default) value.
function resolveThemed(ctx, value, theme) {
  if (!Array.isArray(value)) return value;
  const cur = theme || ctx.theme;
  let best = value[0], bestKeys = -1;
  for (const e of value) {
    const t = e.theme || {};
    const keys = Object.keys(t);
    const matches = keys.every((k) => (cur[k] != null ? cur[k] : (ctx.themes[k] || [])[0]) === t[k]);
    if (matches && keys.length > bestKeys) { best = e; bestKeys = keys.length; }
  }
  return best.value;
}

function applyTheme(ctx, node, n) {
  const value = n.theme && ctx.themeAxis && n.theme[ctx.themeAxis];
  if (value && ctx.themeModes[value]) node.setExplicitVariableModeForCollection(ctx.themeColl, ctx.themeModes[value]);
}

// resolve `$name` references for non-color props (numbers, strings)
function rv(ctx, v) {
  if (typeof v === "string" && v[0] === "$") {
    const def = ctx.vars[v.slice(1)];
    return def ? rv(ctx, resolveThemed(ctx, def.value)) : v;
  }
  return v;
}

// ---------- paints ----------

function hex(h) {
  h = String(h).replace("#", "");
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }, opacity: a };
}

function gradientTransform(rotation) {
  // pen rotation is CCW: 0 = to top, 90 = to left, 180 = to bottom, 270 = to right. Figma identity is left→right.
  const phi = ((-(rotation == null ? 180 : rotation) - 90) * Math.PI) / 180;
  const c = Math.cos(phi), s = Math.sin(phi);
  return [[c, s, 0.5 - 0.5 * c - 0.5 * s], [-s, c, 0.5 + 0.5 * s - 0.5 * c]];
}

// pen center/size are normalized to the bbox (size = ellipse diameters, rotated CCW about the center);
// Figma's radial/angular is the ellipse inscribed in the unit square. Maps node space → gradient space.
// Angular sweeps start at 12 o'clock in Pen and at 3 o'clock in Figma, hence `offset` = 90 for them.
function radialTransform(ctx, f, offset) {
  const c = f.center || {}, s = f.size || {};
  const cx = c.x == null ? 0.5 : num(ctx, c.x), cy = c.y == null ? 0.5 : num(ctx, c.y);
  const w = num(ctx, s.width) || 1, h = num(ctx, s.height) || 1;
  const th = (((num(ctx, f.rotation) || 0) + (offset || 0)) * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
  const m = [[cos / w, -sin / w], [sin / h, cos / h]];
  return [
    [m[0][0], m[0][1], 0.5 - m[0][0] * cx - m[0][1] * cy],
    [m[1][0], m[1][1], 0.5 - m[1][0] * cx - m[1][1] * cy],
  ];
}

// pen image transform maps image coords (0..1) into the crop box: invert it to get the cropped region,
// then fit that region into the node the way Pen does. Axis-aligned crops with cover/stretch only.
function cropTransform(f, img, size) {
  const [a, b, c, d, tx, ty] = f.transform;
  if (b || c || !a || !d || f.mode === "contain") return null;
  const u0 = -tx / a, v0 = -ty / d, uw = 1 / a, vh = 1 / d;
  if (f.mode === "stretch") return [[uw, 0, u0], [0, vh, v0]];
  const s = Math.max(size.w / (uw * img.width), size.h / (vh * img.height));
  const sw = size.w / s / img.width, sh = size.h / s / img.height;
  return [[sw, 0, u0 + (uw - sw) / 2], [0, sh, v0 + (vh - sh) / 2]];
}

// "linearBurn" → "LINEAR_BURN"; pen's "light" is Figma's LIGHTEN
function blendMode(m) {
  return m === "light" ? "LIGHTEN" : String(m || "normal").replace(/[A-Z]/g, (x) => "_" + x).toUpperCase();
}

async function preloadImageSizes(ctx, nodes) {
  const walk = async (n) => {
    for (const f of Array.isArray(n.fill) ? n.fill : [n.fill]) {
      if (f && f.type === "image" && f.transform && !ctx.imageSizes[f.url] && ctx.assets && ctx.assets[f.url]) {
        ctx.imageSizes[f.url] = await figma.createImage(ctx.assets[f.url]).getSizeAsync();
      }
    }
    for (const c of n.children || []) await walk(c);
  };
  for (const n of nodes) await walk(n);
}

function imageHash(ctx, url) {
  if (ctx.imageHashes[url]) return ctx.imageHashes[url];
  const bytes = ctx.assets && ctx.assets[url];
  if (!bytes) { ctx.missingImages.add(url); return null; }
  const h = figma.createImage(bytes).hash;
  ctx.imageHashes[url] = h;
  return h;
}

function paint(ctx, f, size) {
  if (f == null) return null;
  if (typeof f === "string") {
    if (f[0] === "$") {
      const v = ctx.varNodes[f.slice(1)];
      if (v) return figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", v);
      const raw = rv(ctx, f);
      if (typeof raw === "string" && raw[0] === "#") { const { color, opacity } = hex(raw); return { type: "SOLID", color, opacity }; }
      return { type: "SOLID", color: { r: 1, g: 0, b: 1 } };
    }
    const { color, opacity } = hex(f);
    return { type: "SOLID", color, opacity };
  }
  if (f.enabled === false) return null;
  let p = null;
  if (f.type === "solid" || f.color) {
    p = paint(ctx, f.color);
  } else if (f.type === "image") {
    const h = imageHash(ctx, f.url);
    const crop = h && f.transform && size && ctx.imageSizes[f.url] && cropTransform(f, ctx.imageSizes[f.url], size);
    p = !h ? null
      : crop ? { type: "IMAGE", imageHash: h, scaleMode: "CROP", imageTransform: crop }
      : f.mode === "stretch"
        ? { type: "IMAGE", imageHash: h, scaleMode: "CROP", imageTransform: [[1, 0, 0], [0, 1, 0]] }
        : { type: "IMAGE", imageHash: h, scaleMode: f.mode === "contain" ? "FIT" : "FILL" };
    if (!p) p = { type: "SOLID", color: { r: 0.22, g: 0.2, b: 0.18 } };
  } else if (f.type === "gradient") {
    const stops = (f.colors || []).map((c) => {
      const raw = rv(ctx, c.color);
      const { color, opacity } = hex(raw);
      return { position: c.position, color: { ...color, a: opacity } };
    });
    p = f.gradientType === "radial" || f.gradientType === "angular"
      ? { type: f.gradientType === "radial" ? "GRADIENT_RADIAL" : "GRADIENT_ANGULAR", gradientTransform: radialTransform(ctx, f, f.gradientType === "angular" ? 90 : 0), gradientStops: stops }
      : { type: "GRADIENT_LINEAR", gradientTransform: gradientTransform(num(ctx, f.rotation)), gradientStops: stops };
  }
  if (p && f.opacity != null) p = { ...p, opacity: num(ctx, f.opacity) };
  if (p && f.blendMode && f.blendMode !== "normal") p = { ...p, blendMode: blendMode(f.blendMode) };
  return p;
}

function paints(ctx, f, size) {
  const arr = Array.isArray(f) ? f : [f];
  const out = [];
  for (const x of arr) { const p = paint(ctx, x, size); if (p) out.push(p); }
  return out;
}

// ---------- fonts ----------

async function listFontStyles() {
  const fonts = await figma.listAvailableFontsAsync();
  const byFamily = {};
  for (const f of fonts) (byFamily[f.fontName.family] ||= []).push(f.fontName.style);
  return byFamily;
}

const WEIGHT_NAMES = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };

function fontName(ctx, n) {
  const family = rv(ctx, n.fontFamily) || "Inter";
  let w = n.fontWeight == null ? 400 : rv(ctx, n.fontWeight);
  if (w === "normal") w = 400; else if (w === "bold") w = 700; else w = parseInt(w, 10) || 400;
  const italic = n.fontStyle === "italic";
  const want = `${WEIGHT_NAMES[w] || "Regular"}${italic ? "Italic" : ""}`.toLowerCase();
  const key = `${family}|${want}`;
  if (ctx.fontCache[key]) return ctx.fontCache[key];
  const styles = ctx.fontStyles[family];
  let picked = null;
  if (styles) {
    const norm = (s) => s.replace(/[\s-]/g, "").toLowerCase();
    picked = styles.find((s) => norm(s) === want)
      || styles.find((s) => norm(s) === want.replace("regularitalic", "italic"))
      || styles.find((s) => norm(s) === (italic ? "italic" : "regular"))
      || styles[0];
  }
  const fn = picked ? { family, style: picked } : { family: "Inter", style: italic ? "Italic" : w >= 600 ? "Bold" : "Regular" };
  if (!picked) ctx.missingFonts.add(family);
  ctx.fontCache[key] = fn;
  return fn;
}

async function preloadFonts(ctx, nodes) {
  const seen = new Set();
  const walk = async (n) => {
    if (n.type === "text") {
      const fn = fontName(ctx, n);
      const k = `${fn.family}/${fn.style}`;
      if (!seen.has(k)) { seen.add(k); await figma.loadFontAsync(fn); }
    }
    for (const c of n.children || []) await walk(c);
  };
  for (const n of nodes) await walk(n);
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  log(`fonts: ${[...seen].join(", ")}`);
}

// ---------- nodes ----------

const JUSTIFY = { start: "MIN", center: "CENTER", end: "MAX", space_between: "SPACE_BETWEEN" };
const ALIGN = { start: "MIN", center: "CENTER", end: "MAX" };

function num(ctx, v) { const r = rv(ctx, v); return typeof r === "number" ? r : undefined; }

// pen sizing behaviours may carry a fallback size: "fill_container(0)", "fit_content(100)"
function behavior(v) { return typeof v === "string" ? v.replace(/\(.*\)$/, "") : v; }
function fallback(v) { const m = typeof v === "string" && /\(([\d.]+)\)$/.exec(v); return m ? Number(m[1]) : undefined; }

// When a pen property referenced a variable (`$name`), bind the Figma field to it on top of the value already set.
function bind(ctx, node, field, raw) {
  if (typeof raw !== "string" || raw[0] !== "$") return;
  const v = ctx.varNodes[raw.slice(1)];
  if (!v) return;
  try { node.setBoundVariable(field, v); } catch (e) { ctx.skipped.add(`variable binding on ${field}`); }
}

function applyPadding(ctx, node, p) {
  if (p == null) return;
  const r = Array.isArray(p) ? p : [p];
  const sides = r.length === 1 ? [r[0], r[0], r[0], r[0]] : r.length === 2 ? [r[0], r[1], r[0], r[1]] : r.length === 3 ? [r[0], r[1], r[2], r[1]] : r;
  ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].forEach((f, i) => { node[f] = num(ctx, sides[i]) || 0; bind(ctx, node, f, sides[i]); });
}

// auto-layout properties of a frame
function applyLayout(ctx, node, n) {
  if (n.layout !== "none") {
    const gap = num(ctx, n.gap); if (gap != null) { node.itemSpacing = gap; bind(ctx, node, "itemSpacing", n.gap); }
    applyPadding(ctx, node, n.padding);
    if (n.justifyContent) node.primaryAxisAlignItems = JUSTIFY[n.justifyContent] || "MIN";
    if (n.alignItems) node.counterAxisAlignItems = ALIGN[n.alignItems] || "MIN";
    if (n.wrap) node.layoutWrap = "WRAP";
  }
  if (n.layoutIncludeStroke) node.strokesIncludedInLayout = true;
  node.clipsContent = !!rv(ctx, n.clip);
}

function applyCorners(ctx, node, n) {
  if (n.cornerRadius == null) return;
  const r = Array.isArray(n.cornerRadius) ? n.cornerRadius : [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius];
  if ("topLeftRadius" in node) {
    ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"].forEach((f, i) => { node[f] = num(ctx, r[i]) || 0; bind(ctx, node, f, r[i]); });
  } else if ("cornerRadius" in node && num(ctx, r[0]) != null) node.cornerRadius = num(ctx, r[0]);
}

// icons and paths are SVG imports, so their colour lives on the vector children
function applyFill(ctx, node, n) {
  if (n.type === "icon") {
    const ps = paints(ctx, n.fill);
    if (ps.length) for (const d of node.findAll((x) => "strokes" in x)) {
      if (d.strokes && d.strokes.length) d.strokes = ps;
      if (d.fills && d.fills.length) d.fills = ps;
    }
    return;
  }
  if (n.type === "path") {
    const fp = paints(ctx, n.fill), sp = paints(ctx, n.stroke);
    for (const d of node.findAll((x) => "fills" in x)) { d.fills = fp; d.strokes = sp; applyStrokeEnds(d, n); }
    return;
  }
  node.fills = paints(ctx, n.fill);
  if ((Array.isArray(n.fill) ? n.fill : [n.fill]).some((f) => f && f.type === "image" && f.transform)) ctx.pendingCrops.push({ node, fill: n.fill });
}

function applyStroke(ctx, node, n) {
  if (!("strokes" in node)) return;
  if (n.stroke == null) { node.strokes = []; return; }
  node.strokes = paints(ctx, n.stroke);
  const raw = n.strokeWidth == null ? 1 : n.strokeWidth;
  const sw = rv(ctx, raw);
  if (typeof sw === "number") { node.strokeWeight = sw; bind(ctx, node, "strokeWeight", raw); }
  else if (sw && typeof sw === "object" && "strokeTopWeight" in node) {
    for (const [side, f] of [["top", "strokeTopWeight"], ["right", "strokeRightWeight"], ["bottom", "strokeBottomWeight"], ["left", "strokeLeftWeight"]]) {
      node[f] = num(ctx, sw[side]) || 0; bind(ctx, node, f, sw[side]);
    }
  }
  node.strokeAlign = n.strokeAlignment === "outer" ? "OUTSIDE" : n.strokeAlignment === "center" ? "CENTER" : "INSIDE";
  applyStrokeEnds(node, n);
}

const CAPS = { butt: "NONE", round: "ROUND", square: "SQUARE" };
function applyStrokeEnds(node, n) {
  if (n.strokeLinecap && "strokeCap" in node) node.strokeCap = CAPS[n.strokeLinecap] || "NONE";
  if (n.strokeLinejoin && "strokeJoin" in node) node.strokeJoin = n.strokeLinejoin.toUpperCase();
}

// pen flips mirror the node in place; Figma has no flip flag, so compose a mirror into its transform
function applyFlip(ctx, node, n) {
  const fx = rv(ctx, n.flipX) === true, fy = rv(ctx, n.flipY) === true;
  if (!fx && !fy) return;
  const [[a, b, tx], [c, d, ty]] = node.relativeTransform;
  const ox = fx ? node.width : 0, oy = fy ? node.height : 0;
  try {
    node.relativeTransform = [
      [fx ? -a : a, fy ? -b : b, a * ox + b * oy + tx],
      [fx ? -c : c, fy ? -d : d, c * ox + d * oy + ty],
    ];
  } catch (e) { ctx.skipped.add(`flip on ${n.type}`); }
}

function applyEffects(ctx, node, n) {
  if (!("effects" in node)) return;
  const out = [];
  for (const e of n.effect == null ? [] : Array.isArray(n.effect) ? n.effect : [n.effect]) {
    if (!e || rv(ctx, e.enabled) === false) continue;
    if (e.type === "shadow") {
      const { color, opacity } = hex(rv(ctx, e.color) || "#00000040");
      const o = e.offset || {};
      let fx = { type: e.shadowType === "inner" ? "INNER_SHADOW" : "DROP_SHADOW", color: { ...color, a: opacity }, offset: { x: num(ctx, o.x) || 0, y: num(ctx, o.y) || 0 }, radius: num(ctx, e.blur) || 0, spread: num(ctx, e.spread) || 0, visible: true, blendMode: blendMode(e.blendMode) };
      const v = typeof e.color === "string" && e.color[0] === "$" && ctx.varNodes[e.color.slice(1)];
      if (v) fx = figma.variables.setBoundVariableForEffect(fx, "color", v);
      out.push(fx);
    } else if (e.type === "blur" || e.type === "background_blur") {
      out.push({ type: e.type === "blur" ? "LAYER_BLUR" : "BACKGROUND_BLUR", blurType: "NORMAL", radius: num(ctx, e.radius) || 0, visible: true });
    }
  }
  node.effects = out;
}

function applyTextStyle(ctx, node, n) {
  node.fontName = fontName(ctx, n);
  bind(ctx, node, "fontFamily", n.fontFamily);
  node.fontSize = num(ctx, n.fontSize) || 14;
  bind(ctx, node, "fontSize", n.fontSize);
  const lh = num(ctx, n.lineHeight);
  node.lineHeight = lh != null ? { unit: "PERCENT", value: lh * 100 } : { unit: "AUTO" };
  const ls = num(ctx, n.letterSpacing);
  if (ls != null) { node.letterSpacing = { unit: "PIXELS", value: ls }; bind(ctx, node, "letterSpacing", n.letterSpacing); }
  node.textAlignHorizontal = !n.textAlign ? "LEFT" : n.textAlign === "justify" ? "JUSTIFIED" : n.textAlign.toUpperCase();
  node.textAlignVertical = !n.textAlignVertical ? "TOP" : n.textAlignVertical === "middle" ? "CENTER" : n.textAlignVertical.toUpperCase();
  node.textDecoration = rv(ctx, n.underline) === true ? "UNDERLINE" : rv(ctx, n.strikethrough) === true ? "STRIKETHROUGH" : "NONE";
  if (n.href) node.hyperlink = { type: "URL", value: n.href };
  if (n.textCase) node.textCase = n.textCase === "uppercase" ? "UPPER" : n.textCase === "lowercase" ? "LOWER" : n.textCase === "capitalize" ? "TITLE" : "ORIGINAL";
}

function applyContent(ctx, node, n) {
  const c = rv(ctx, n.content);
  node.characters = c == null ? "" : String(c);
  bind(ctx, node, "characters", n.content);
}

function applyTextGrowth(ctx, node, n) {
  const g = n.textGrowth || "auto";
  if (g === "fixed-width" || g === "fixed-width-height") {
    node.textAutoResize = g === "fixed-width" ? "HEIGHT" : "NONE";
    const w = num(ctx, n.width), h = num(ctx, n.height);
    if (w != null) node.resize(w, node.height);
    if (g === "fixed-width-height" && h != null) node.resize(node.width, h);
  } else node.textAutoResize = "WIDTH_AND_HEIGHT";
}

function resizeIfFixed(ctx, node, n) {
  let w = num(ctx, n.width), h = num(ctx, n.height);
  // fallback sizes apply when the behaviour can't (e.g. a root frame); FILL/HUG override them after appendChild
  if (w == null && fallback(n.width) > 0) w = fallback(n.width);
  if (h == null && fallback(n.height) > 0) h = fallback(n.height);
  if (w != null || h != null) node.resize(w != null ? w : node.width, h != null ? h : node.height);
  bind(ctx, node, "width", n.width);
  bind(ctx, node, "height", n.height);
}

// FILL/HUG are only valid once the node sits in an auto-layout parent
function applyLayoutSizing(ctx, node, n, sizable) {
  const parent = node.parent;
  const inLayout = parent && parent.layoutMode && parent.layoutMode !== "NONE";
  if (inLayout && n.layoutPosition === "absolute") {
    // instance sublayers already inherit ABSOLUTE and refuse the write
    if (node.layoutPositioning !== "ABSOLUTE") node.layoutPositioning = "ABSOLUTE";
    if (n.x != null) node.x = n.x; if (n.y != null) node.y = n.y;
  } else if (inLayout) {
    // HUG only exists for text and auto-layout frames
    sizable = sizable && (node.type === "TEXT" || (node.layoutMode && node.layoutMode !== "NONE"));
    if (behavior(n.width) === "fill_container") node.layoutSizingHorizontal = "FILL";
    else if (num(ctx, n.width) == null && sizable) node.layoutSizingHorizontal = "HUG";
    if (behavior(n.height) === "fill_container") node.layoutSizingVertical = "FILL";
    else if (num(ctx, n.height) == null && sizable) node.layoutSizingVertical = "HUG";
  } else {
    if (n.x != null) node.x = n.x; if (n.y != null) node.y = n.y;
  }
}

// figma.createAutoLayout only exists in the Figma MCP sandbox, not in the plugin API
function autoLayout(direction) {
  const f = figma.createFrame();
  f.layoutMode = direction;
  f.primaryAxisSizingMode = "AUTO";
  f.counterAxisSizingMode = "AUTO";
  return f;
}

function svgNode(ctx, svg, name) {
  const node = figma.createNodeFromSvg(svg);
  node.name = name;
  return node;
}

// Material Symbols ship one SVG per weight; mirrors iconKey() in lib/pen.mjs.
function iconKey(n) {
  const lib = n.library || "lucide";
  if (!lib.startsWith("Material Symbols")) return `${lib}/${n.icon}`;
  const w = Math.min(700, Math.max(100, Math.round((typeof n.weight === "number" ? n.weight : 400) / 100) * 100));
  return `${lib}/${n.icon}@${w}`;
}

// ---------- components & instances ----------

// Builds the Figma component for a pen reusable node once. Selected components stay where they are in Pen;
// components only used by the selection are stacked in a "pen.dev components" frame next to the import.
async function ensureComponent(ctx, id) {
  if (ctx.comps[id]) return ctx.comps[id];
  const def = ctx.defs[id];
  if (!def || ctx.defBuilding.has(id)) return null;
  ctx.defBuilding.add(id);
  try {
    const parent = ctx.rootIds.has(id) ? figma.currentPage : componentArea(ctx);
    const comp = figma.createComponentFromNode(await build(ctx, def, parent));
    comp.description = `pen.dev component ${def.name || ""}`.trim();
    if (parent === ctx.area) {
      comp.x = 0; comp.y = ctx.areaSize.h;
      ctx.areaSize.h += comp.height + 80;
      ctx.areaSize.w = Math.max(ctx.areaSize.w, comp.width);
    }
    ctx.comps[id] = comp;
    return comp;
  } finally {
    ctx.defBuilding.delete(id);
  }
}

function componentArea(ctx) {
  if (!ctx.area) {
    ctx.area = figma.createFrame();
    ctx.area.name = "pen.dev components";
    ctx.area.fills = [];
    ctx.area.clipsContent = false;
    figma.currentPage.appendChild(ctx.area);
    ctx.areaSize = { w: 1, h: 0 };
  }
  return ctx.area;
}

// Properties an instance can override in Figma. Anything else (icon swaps, replaced layers, layout mode...)
// can't be expressed on an instance, so that instance is built as a plain frame instead.
const TEXT_KEYS = new Set(["fontSize", "fontFamily", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textAlign", "textAlignVertical", "underline", "strikethrough", "href", "textCase"]);
const LAYOUT_KEYS = new Set(["gap", "padding", "justifyContent", "alignItems", "wrap", "layoutIncludeStroke", "clip"]);
const STROKE_KEYS = new Set(["stroke", "strokeWidth", "strokeAlignment", "strokeLinecap", "strokeLinejoin"]);
const OVERRIDABLE = new Set(["name", "content", "fill", "effect", "enabled", "opacity", "cornerRadius", "width", "height", "textGrowth", "x", "y", "rotation", ...TEXT_KEYS, ...LAYOUT_KEYS, ...STROKE_KEYS]);
const NOT_COMPARED = new Set(["id", "children", "reusable", "metadata", "context", "placeholder"]);
// the instance root's own size, position and visibility are set by buildNode like any other node
const ROOT_HANDLED = new Set(["name", "width", "height", "x", "y", "layoutPosition", "enabled", "rotation", "theme", "flipX", "flipY"]);

// JSON with sorted keys, so property order doesn't count as a difference
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// Walks the component definition and the resolved instance side by side and collects what differs.
// Returns a reason string when the instance can't be expressed as a Figma instance.
function diffInstance(def, n, path, out) {
  if (def.type !== n.type) return `${n.name || n.type}: layer replaced`;
  const keys = [...new Set([...Object.keys(def), ...Object.keys(n)])]
    .filter((k) => !NOT_COMPARED.has(k) && !(path.length === 0 && ROOT_HANDLED.has(k)) && stable(def[k]) !== stable(n[k]));
  const bad = keys.find((k) => !OVERRIDABLE.has(k));
  if (bad) return `${n.name || n.type}: "${bad}" changed`;
  if (keys.length) out.push({ path, n, keys });
  const dc = Array.isArray(def.children) ? def.children : [], nc = Array.isArray(n.children) ? n.children : [];
  if (dc.length !== nc.length) return `${n.name || n.type}: layers added or removed`;
  for (let i = 0; i < dc.length; i++) {
    const why = diffInstance(dc[i], nc[i], [...path, i], out);
    if (why) return why;
  }
  return null;
}

async function tryInstance(ctx, n, compId, refInfo) {
  const def = ctx.defs[compId];
  if (!def) return null;
  const replaced = refInfo && Object.keys(refInfo.descendants).find((k) => refInfo.descendants[k] && refInfo.descendants[k].type);
  const diffs = [];
  const why = replaced ? `${n.name || n.id}: layer replaced` : diffInstance(def, n, [], diffs);
  if (why) { ctx.detached.add(why); return null; }
  const comp = await ensureComponent(ctx, compId);
  if (!comp) return null;
  const inst = comp.createInstance();
  // Figma instance sublayers mirror the component tree, so pen child index i is Figma child index i.
  // Figma rejects some overrides on sublayers; then the instance falls back to a plain frame.
  try {
    for (const { path, n: o, keys } of diffs) {
      let f = inst;
      for (const i of path) f = f.children[i];
      applyOverrides(ctx, f, o, keys);
    }
  } catch (e) {
    inst.remove();
    ctx.detached.add(`${n.name || n.id}: override not allowed (${e.message})`);
    return null;
  }
  return inst;
}

function applyOverrides(ctx, f, n, keys) {
  const has = (set) => keys.some((k) => set.has(k));
  if (keys.includes("name")) f.name = n.name || n.type;
  if (n.type === "text" && has(TEXT_KEYS)) applyTextStyle(ctx, f, n);
  if (keys.includes("content")) applyContent(ctx, f, n);
  if (keys.includes("fill") || (n.type === "path" && has(STROKE_KEYS))) applyFill(ctx, f, n);
  if (n.type !== "path" && has(STROKE_KEYS)) applyStroke(ctx, f, n);
  if (keys.includes("effect")) applyEffects(ctx, f, n);
  if (keys.includes("enabled")) { f.visible = rv(ctx, n.enabled) !== false; bind(ctx, f, "visible", n.enabled); }
  if (keys.includes("opacity")) { f.opacity = n.opacity == null ? 1 : num(ctx, n.opacity); bind(ctx, f, "opacity", n.opacity); }
  if (keys.includes("rotation")) f.rotation = num(ctx, n.rotation) || 0;
  if (keys.includes("cornerRadius")) applyCorners(ctx, f, n);
  if (has(LAYOUT_KEYS)) applyLayout(ctx, f, n);
  if (keys.includes("width") || keys.includes("height") || keys.includes("textGrowth")) {
    if (n.type === "text") applyTextGrowth(ctx, f, n); else resizeIfFixed(ctx, f, n);
    applyLayoutSizing(ctx, f, n, n.type === "frame" || n.type === "text");
  } else if (keys.includes("x") || keys.includes("y")) applyLayoutSizing(ctx, f, n, false);
}

// A node's `theme` applies to its whole subtree.
async function build(ctx, n, parent) {
  const prev = ctx.theme;
  if (n.theme) ctx.theme = { ...prev, ...n.theme };
  try { return await buildNode(ctx, n, parent); } finally { ctx.theme = prev; }
}

async function buildNode(ctx, n, parent) {
  let node;
  const t = n.type;
  // nodes Figma can't rebuild (browser, shader, mesh gradient...) arrive as a PNG rendered by Pen
  const raster = ctx.rasters[n.id];
  // a pen instance (or another placement of a reusable node) becomes an instance of its Figma component
  const refInfo = ctx.refs[n.id];
  const compId = refInfo ? refInfo.ref : n.reusable && !ctx.defBuilding.has(n.id) ? n.id : null;
  const inst = compId && !raster ? await tryInstance(ctx, n, compId, refInfo) : null;

  if (inst) {
    node = inst;
    resizeIfFixed(ctx, node, n);
  } else if (raster) {
    node = figma.createFrame();
    const h = imageHash(ctx, raster.url);
    node.fills = h ? [{ type: "IMAGE", imageHash: h, scaleMode: "FILL" }] : [];
    node.resize(raster.width, raster.height);
  } else if (t === "text") {
    node = figma.createText();
    applyTextStyle(ctx, node, n);
    applyContent(ctx, node, n);
    applyFill(ctx, node, n);
    applyTextGrowth(ctx, node, n);
  } else if (t === "icon") {
    const svg = ctx.icons[iconKey(n)];
    const w = num(ctx, n.width) || 16, h = num(ctx, n.height) || w;
    if (svg) {
      node = svgNode(ctx, svg, n.name || n.icon);
      if (node.width) node.rescale(w / node.width);
      applyFill(ctx, node, n);
      node.fills = []; node.clipsContent = false;
    } else {
      ctx.missingIcons.add(iconKey(n));
      node = figma.createFrame(); node.fills = []; node.resize(w, h);
    }
  } else if (t === "path") {
    const vb = n.viewBox || [0, 0, num(ctx, n.width) || 24, num(ctx, n.height) || 24];
    const fill = n.fill != null ? "currentColor" : "none";
    const stroke = n.stroke != null ? "currentColor" : "none";
    const sw = num(ctx, n.strokeWidth) || 1;
    node = svgNode(ctx, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}"><path d="${n.geometry || ""}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/></svg>`, n.name || "Path");
    applyFill(ctx, node, n);
    node.fills = []; node.clipsContent = false;
    resizeIfFixed(ctx, node, n);
  } else if (t === "rectangle") {
    node = figma.createRectangle(); applyFill(ctx, node, n); resizeIfFixed(ctx, node, n);
  } else if (t === "ellipse") {
    node = figma.createEllipse(); applyFill(ctx, node, n); resizeIfFixed(ctx, node, n);
    // pen angles are degrees CCW from the right; Figma's are radians clockwise (y points down)
    const start = num(ctx, n.startAngle) || 0, sweep = n.sweepAngle == null ? 360 : num(ctx, n.sweepAngle);
    const a1 = (-start * Math.PI) / 180, a2 = (-(start + sweep) * Math.PI) / 180;
    if (n.innerRadius != null || Math.abs(sweep) < 360) {
      node.arcData = { startingAngle: Math.min(a1, a2), endingAngle: Math.max(a1, a2), innerRadius: num(ctx, n.innerRadius) || 0 };
    }
  } else if (t === "polygon") {
    node = figma.createPolygon(); node.pointCount = num(ctx, n.polygonCount) || 3;
    applyFill(ctx, node, n); resizeIfFixed(ctx, node, n);
  } else if (t === "line") {
    node = figma.createLine(); resizeIfFixed(ctx, node, n);
  } else if (t === "group") {
    const tmp = figma.createFrame(); tmp.fills = []; tmp.clipsContent = false; tmp.name = "tmp";
    parent.appendChild(tmp);
    for (const c of n.children || []) await build(ctx, c, tmp);
    node = tmp.children.length ? figma.group([...tmp.children], parent) : figma.createFrame();
    tmp.remove();
    node.name = n.name || "Group";
    if (n.opacity != null) { node.opacity = num(ctx, n.opacity); bind(ctx, node, "opacity", n.opacity); }
    if (rv(ctx, n.enabled) === false) node.visible = false;
    bind(ctx, node, "visible", n.enabled);
    applyEffects(ctx, node, n);
    applyTheme(ctx, node, n);
    if (n.x != null) node.x = n.x; if (n.y != null) node.y = n.y;
    ctx.created++;
    return node;
  } else {
    if (t !== "frame") ctx.unknownTypes.add(t);
    node = n.layout === "none" ? figma.createFrame() : autoLayout(n.layout === "vertical" ? "VERTICAL" : "HORIZONTAL");
    applyFill(ctx, node, n);
    applyLayout(ctx, node, n);
    resizeIfFixed(ctx, node, n);
  }

  node.name = n.name || t;
  // a raster already has corners, strokes, effects and opacity baked in; an instance inherits them
  if (!raster && !inst) {
    applyCorners(ctx, node, n);
    if (n.stroke != null) applyStroke(ctx, node, n);
    if (n.effect != null) applyEffects(ctx, node, n);
    if (n.opacity != null) { node.opacity = num(ctx, n.opacity); bind(ctx, node, "opacity", n.opacity); }
  }
  if (rv(ctx, n.enabled) === false) node.visible = false;
  bind(ctx, node, "visible", n.enabled);
  if (n.rotation) node.rotation = num(ctx, n.rotation);
  applyTheme(ctx, node, n);

  parent.appendChild(node);
  ctx.created++;
  applyLayoutSizing(ctx, node, n, !raster && (inst || t === "frame" || t === "text" || (t !== "icon" && t !== "path" && "layoutMode" in node)));

  if (!raster && !inst) for (const c of n.children || []) await build(ctx, c, node);
  applyFlip(ctx, node, n);
  return node;
}
