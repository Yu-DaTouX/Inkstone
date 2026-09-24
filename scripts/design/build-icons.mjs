import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";

/* ============================================================
   Reicon 图标构建
   1. 解析图标清单，算出设计稿需要哪些图标
   2. 从 unpkg 拉取 reicon@1.2.4 的模块，取出 Outline(O) 与 Filled(F) 两个变体
   3. 生成 SVG sprite（symbol） + TS 模块 + 预览页
   ============================================================ */

const ICONS_TXT = "reicon-icons.txt";
const VERSION = "1.2.4";
const BASE = `https://unpkg.com/reicon@${VERSION}/icons/`;
const OUT = "icons";
const CACHE = "icons/.cache";

const list = readFileSync(ICONS_TXT, "utf8");
const ALL = new Map();
for (const m of list.matchAll(/^-\s+([a-z0-9-]+)\s+->\s+(\S+)$/gm)) ALL.set(m[1], m[2]);

/* ---------- 1. 需要哪些图标 ---------- */

const GROUPS = {
  "nav 导航": ["search", "plus", "minus", "x", "check", "chevron-down", "chevron-right",
               "chevron-left", "chevron-up", "more-horizontal", "menu", "sidebar-left", "sidebar-right"],
  "folder 文件夹": ["folder", "folder-open", "folder-add", "file", "file-text", "file-check",
                    "file-minus", "tree", "list-check", "checklist"],
  "vcs 版本控制": ["git-branch", "git-commit", "git-merge", "git-pull-request", "branch-down",
                   "branch-up", "refresh", "undo", "history"],
  "run 运行": ["terminal-square", "terminal-circle", "command", "code", "code-file", "play",
               "stop", "pause", "loader", "zap", "flash", "clock"],
  "state 状态": ["check-circle", "close-circle", "alert-triangle", "alert-circle", "info-circle",
                 "information", "shield-check"],
  "edit 编辑": ["edit", "copy", "clipboard", "trash", "eye", "filter", "sort", "layers", "box", "package"],
  "cost 计费": ["coin", "coins", "wallet", "receipt", "tag", "activity", "trending-up", "cpu-charge", "cpu"],
  "ui 界面": ["settings", "sliders", "sun", "moon", "globe", "language", "translate",
              "maximize", "minimize", "expand", "layout", "drag", "arrange-square"],
  "ai 模型": ["sparkle", "sparkles", "brain", "message-dots", "message-circle", "chat-round",
              "send", "message", "magic"],
};

// 首选名不存在时的备用名（按顺序）
const ALIAS = {
  "folder-open": ["folder-open", "folder"],
  "folder-add": ["folder-add", "folder-add3", "folder"],
  "file-text": ["file-text", "file-content", "file"],
  "x": ["x", "close", "close-circle"],
  "chevron-right": ["chevron-right", "angle-right"],
  "chevron-left": ["chevron-left", "angle-left"],
  "chevron-up": ["chevron-up", "angle-up"],
  "chevron-down": ["chevron-down", "angle-down"],
  "more-horizontal": ["more-horizontal", "more", "menu"],
  "sidebar-left": ["sidebar-left", "sidebar", "layout"],
  "sidebar-right": ["sidebar-right", "sidebar", "layout"],
  "tree": ["tree", "layers", "list"],
  "list-check": ["list-check", "checklist", "check-list"],
  "checklist": ["checklist", "list-check", "check-list"],
  "git-branch": ["git-branch", "branch-down", "branch-up"],
  "git-commit": ["git-commit", "branch-down", "git-branch"],
  "git-merge": ["git-merge", "branch-up", "git-branch"],
  "git-pull-request": ["git-pull-request", "send"],
  "terminal-square": ["terminal-square", "terminal-circle"],
  "code-file": ["code-file", "code"],
  "loader": ["loader", "refresh"],
  "zap": ["zap", "flash", "bolt", "cpu-bolt"],
  "flash": ["flash", "zap", "bolt"],
  "history": ["history", "clock"],
  "check-circle": ["check-circle", "check"],
  "close-circle": ["close-circle", "x"],
  "alert-triangle": ["alert-triangle", "warning", "alert"],
  "alert-circle": ["alert-circle", "alert"],
  "info-circle": ["info-circle", "information"],
  "information": ["information", "info-circle"],
  // reicon 没有裸 circle，空态圆点用 CSS 画（见 DESIGN.md）
  "circle": ["check-circle"],
  "edit": ["edit", "pen", "pencil"],
  "eye": ["eye", "eye-open"],
  "layers": ["layers", "layers-alt", "stack-perspective"],
  "box": ["box", "package"],
  "coin": ["coin", "coins"],
  "coins": ["coins", "coin"],
  "wallet": ["wallet", "coin"],
  "receipt": ["receipt", "file"],
  "tag": ["tag", "tag-price"],
  "activity": ["activity", "trending-up"],
  "trending-up": ["trending-up", "activity"],
  "cpu-charge": ["cpu-charge", "cpu-bolt", "cpu"],
  "sliders": ["sliders", "settings"],
  "sun": ["sun", "sun2"],
  "moon": ["moon", "moon3"],
  "globe": ["globe", "language"],
  "language": ["language", "translate"],
  "translate": ["translate", "language"],
  "expand": ["expand", "maximize"],
  "layout": ["layout", "sidebar"],
  "drag": ["drag", "arrange-square"],
  "arrange-square": ["arrange-square", "arrange-circle"],
  "brain": ["brain", "sparkle"],
  "message-dots": ["message-dots", "message"],
  "message-circle": ["message-circle", "message"],
  "chat-round": ["chat-round", "chat"],
  "send": ["send", "send-square"],
  "magic": ["magic", "sparkle"],
  "sparkle": ["sparkle", "sparkles"],
  "shield-check": ["shield-check", "shield"],
  "clipboard": ["clipboard", "copy"],
};

const resolved = new Map();  // 设计稿用的名字 -> 真实 kebab 名
const missing = [];
for (const names of Object.values(GROUPS)) {
  for (const w of names) {
    const tries = ALIAS[w] ?? [w];
    const hit = tries.find((t) => ALL.has(t));
    if (hit) resolved.set(w, hit);
    else if (!missing.includes(w)) missing.push(w);
  }
}

// 真实 kebab 去重
const uniqKebab = [...new Set(resolved.values())];
console.log(`设计稿需要 ${resolved.size} 个名字 → 去重后 ${uniqKebab.length} 个图标`);
if (missing.length) console.log(`未能解析: ${missing.join(", ")}`);
console.log();

/* ---------- 2. 抓取 ---------- */

mkdirSync(CACHE, { recursive: true });

function parseModule(txt, kebab) {
  const name = (txt.match(/createIcon\(['"]([^'"]+)['"]/) || [])[1] || kebab;
  const grab = (key) => {
    const m = txt.match(new RegExp("\\b" + key + ":\\s*`([\\s\\S]*?)`\\s*,?\\s*(?=[FO]:|\\}\\))"));
    return m ? m[1].trim() : null;
  };
  // 更稳的做法：按 F:/O: 分别抓，遇到下一个 F:/O: 或 `})` 结束
  const out = {};
  for (const key of ["F", "O"]) {
    const re = new RegExp("\\b" + key + ":\\s*`([\\s\\S]*?)`(?=\\s*[,\\n]\\s*(?:[FO]:|\\}\\)))");
    const m = txt.match(re);
    if (m) out[key] = m[1].trim();
  }
  return { name, ...out };
}

const fetched = new Map(); // kebab -> {name, F, O}
let fetchedCount = 0;

async function fetchOne(kebab) {
  const pascal = ALL.get(kebab);
  const cacheFile = `${CACHE}/${pascal}.js`;
  let txt;
  if (existsSync(cacheFile)) {
    txt = readFileSync(cacheFile, "utf8");
  } else {
    const r = await fetch(BASE + pascal + ".js");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    txt = await r.text();
    writeFileSync(cacheFile, txt, "utf8");
    fetchedCount++;
  }
  const parsed = parseModule(txt, kebab);
  if (!parsed.O && !parsed.F) throw new Error("未解析出路径数据");
  fetched.set(kebab, parsed);
}

const CONC = 6;
const errs = [];
await Promise.all(
  Array.from({ length: CONC }, (_, i) =>
    (async () => {
      for (const k of uniqKebab.filter((_, j) => j % CONC === i)) {
        try { await fetchOne(k); } catch (e) { errs.push(`${k}: ${e.message}`); }
      }
    })(),
  ),
);

console.log(`抓取完成：${fetched.size}/${uniqKebab.length}（新下载 ${fetchedCount}，其余走缓存）`);
if (errs.length) console.log("失败:\n  " + errs.join("\n  "));

/* ---------- 3. 校验 + 生成 ---------- */

/**
 * 把图标内部的 id 加上前缀，避免多个图标拼进同一份 sprite 后 id 冲突。
 * 现在只有 Clock / TerminalCircle 用了 clipPath，但不加前缀未来一定翻车。
 */
function namespaceIds(body, prefix) {
  const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  let out = body;
  for (const id of ids) {
    const safe = prefix + "-" + id;
    out = out.replaceAll(`id="${id}"`, `id="${safe}"`);
    out = out.replaceAll(`url(#${id})`, `url(#${safe})`);
    out = out.replaceAll(`href="#${id}"`, `href="#${safe}"`);
  }
  return { body: out, ids };
}

const problems = [];
const namespaced = new Map(); // kebab -> {O, F}
for (const [kebab, d] of fetched) {
  const next = {};
  for (const w of ["O", "F"]) {
    const raw = d[w];
    if (!raw) continue;
    const { body, ids } = namespaceIds(raw, kebab);
    next[w] = body;
    if (ids.length) problems.push(`${kebab}/${w}: 内部 id ${ids.join(",")} → 已加前缀 ${kebab}-`);
    // 去掉 defs/clipPath 后再查固定尺寸（clipPath 里的 rect 是合法的）
    const noDefs = body.replace(/<(clipPath|defs|mask|pattern)\b[\s\S]*?<\/\1>/g, "");
    if (/(?:^|[\s"])width=|(?:^|[\s"])height=/.test(noDefs)) problems.push(`${kebab}/${w}: 含固定尺寸`);
    if (/#[0-9a-fA-F]{3,8}\b/.test(body)) problems.push(`${kebab}/${w}: 含硬编码颜色 ${body.match(/#[0-9a-fA-F]{3,8}/)[0]}`);
    if (!/currentColor|fill="none"/.test(body)) problems.push(`${kebab}/${w}: 未使用 currentColor`);
  }
  namespaced.set(kebab, next);
}

// 生成后再查一遍：整份 sprite 里是否还有重复 id
const allIds = [];
for (const [kebab, d] of namespaced) {
  for (const w of ["O", "F"]) {
    if (!d[w]) continue;
    for (const m of d[w].matchAll(/\bid="([^"]+)"/g)) allIds.push(m[1]);
  }
}
const dupes = allIds.filter((x, i) => allIds.indexOf(x) !== i);
if (dupes.length) problems.push(`sprite 内重复 id: ${[...new Set(dupes)].join(", ")}`);

if (problems.length) {
  console.log(`\n处理记录 ${problems.length} 条：`);
  for (const p of problems.slice(0, 20)) console.log("   " + p);
  if (problems.length > 20) console.log(`   … 另有 ${problems.length - 20} 条`);
} else {
  console.log("校验通过：无硬编码颜色、无固定尺寸、全部 currentColor、无重复 id");
}

// sprite：id 用 i-<kebab>，Outline 为默认，Filled 加后缀 -f
const symbols = [];
for (const kebab of [...namespaced.keys()].sort()) {
  const d = namespaced.get(kebab);
  if (d.O) symbols.push(`<symbol id="i-${kebab}" viewBox="0 0 24 24">${d.O}</symbol>`);
  if (d.F) symbols.push(`<symbol id="i-${kebab}-f" viewBox="0 0 24 24">${d.F}</symbol>`);
}

mkdirSync(OUT, { recursive: true });
const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${symbols.join("")}</svg>\n`;
writeFileSync(`${OUT}/reicon.svg`, sprite, "utf8");

// TS 模块
const ts = `/**
 * 图标清单 — 由 reicon@${VERSION} 生成，勿手改。
 * 重新生成：node ~/.pi/agent/.dev/build-icons.mjs
 *
 * 用法：
 *   <svg class="ico"><use href="#i-folder"/></svg>          // Outline
 *   <svg class="ico"><use href="#i-folder-f"/></svg>        // Filled
 * 颜色跟随 CSS 的 color，尺寸由 CSS 控制（viewBox 24x24，1.5px 描边）。
 */

export const ICON_VERSION = "${VERSION}";

/** 设计稿用的名字 -> sprite 里的 kebab 命名 */
export const ICON_ALIAS = ${JSON.stringify(Object.fromEntries(resolved), null, 2)} as const;

export type IconName = keyof typeof ICON_ALIAS;

/** 全部可用 symbol id（含 Filled 变体） */
export const ICON_IDS = ${JSON.stringify(symbols.map((s) => s.match(/id="([^"]+)"/)[1]).sort(), null, 2)} as const;

export const ICON_GROUPS = ${JSON.stringify(GROUPS, null, 2)} as const;

/** 取 Outline 图标的 symbol id */
export const iconId = (name: IconName): string => "i-" + ICON_ALIAS[name];

/** 取 Filled 图标的 symbol id */
export const iconIdFilled = (name: IconName): string => "i-" + ICON_ALIAS[name] + "-f";
`;
writeFileSync(`${OUT}/icons.ts`, ts, "utf8");

writeFileSync(`${OUT}/icons.json`, JSON.stringify({
  version: VERSION, license: "MIT", grid: 24, strokeWidth: 1.5,
  source: "https://reicon.dev",
  resolved: Object.fromEntries(resolved),
  resolvedByName: Object.fromEntries([...namespaced].map(([k, v]) => [k, fetched.get(k).name])),
  groups: GROUPS,
}, null, 2) + "\n", "utf8");

/* ---------- 4. 预览页 ---------- */

const preview = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>Reicon 图标集 · pi desktop</title>
<style>
:root{
  --bg:#0b0b0d;--bg2:#121215;--bg3:#17171b;--bd:#26262c;--bd2:#34343c;
  --fg:#d6d6dd;--dim:#a8a8b5;--mute:#82828f;
  --ac:#7aa2f7;--ok:#9ece6a;--warn:#e0af68;--err:#f7768e;--mag:#bb9af7;--cy:#7dcfff;
}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);
  font:12px/1.5 "Maple Mono CN","Cascadia Code",ui-monospace,monospace;-webkit-font-smoothing:antialiased}
h1{font-size:14px;margin:0 0 4px;font-weight:600}
.sub{color:var(--mute);margin:0 0 20px}
.grp{margin-bottom:22px}
.grp h2{font-size:12px;font-weight:600;color:var(--dim);margin:0 0 8px;
  padding-bottom:6px;border-bottom:1px solid var(--bd)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px}
.cell{background:var(--bg2);border:1px solid var(--bd);border-radius:6px;padding:10px 8px;
  display:flex;flex-direction:column;align-items:center;gap:7px;transition:border-color 120ms}
.cell:hover{border-color:var(--bd2)}
.ico{width:22px;height:22px;color:var(--fg);fill:none;flex:none}
.cell:hover .ico{color:var(--ac)}
.nm{font-size:10px;color:var(--mute);text-align:center;word-break:break-all;line-height:1.3}
.sizes{display:flex;gap:26px;align-items:flex-end;background:var(--bg2);border:1px solid var(--bd);
  border-radius:8px;padding:18px;margin-bottom:22px;flex-wrap:wrap}
.szbox{display:flex;flex-direction:column;align-items:center;gap:8px}
.szbox .lbl{font-size:10px;color:var(--mute)}
.colors{display:flex;gap:20px;background:var(--bg2);border:1px solid var(--bd);border-radius:8px;
  padding:16px;margin-bottom:22px;flex-wrap:wrap;align-items:center}
.colors .ico{width:20px;height:20px}
</style>
<body>
<h1>Reicon 图标集</h1>
<p class="sub">reicon@${VERSION} · MIT · 24×24 网格 · Outline 1.5px 描边 · ${namespaced.size} 个图标（含 Filled 共 ${symbols.length} 个 symbol）</p>

<div class="sizes" id="sizes"></div>
<div class="colors" id="colors"></div>
<div id="out"></div>

${sprite}
<script>
const ALIAS = ${JSON.stringify(Object.fromEntries(resolved))};
const GROUPS = ${JSON.stringify(GROUPS)};
const ICON_COUNT = ${symbols.length};

const svg = (id, cls) => \`<svg class="ico \${cls||""}"><use href="#\${id}"/></svg>\`;

// 尺寸示例
document.querySelector("#sizes").innerHTML = [12,14,16,18,20,24,32].map(s =>
  \`<div class="szbox"><div style="height:34px;display:flex;align-items:center">\` +
  \`<svg class="ico" style="width:\${s}px;height:\${s}px"><use href="#i-terminal-square"/></svg></div>\` +
  \`<span class="lbl">\${s}px</span></div>\`).join("") +
  \`<div class="szbox"><div style="height:34px;display:flex;align-items:center">\` +
  \`<svg class="ico" style="width:20px;height:20px"><use href="#i-terminal-square-f"/></svg></div>\` +
  \`<span class="lbl">Filled</span></div>\`;

// 颜色示例
document.querySelector("#colors").innerHTML =
  [["--fg","前景"],["--dim","次要"],["--mute","弱化"],["--ac","进行中"],["--ok","成功"],
   ["--warn","警告"],["--err","失败"],["--mag","分支"],["--cy","行内代码"]].map(([v,l]) =>
  \`<div class="szbox">\${svg("i-shield-check").replace('class="ico "','class="ico" style="color:var(\'+v+\')"')}\` +
  \`<span class="lbl">\${l}</span></div>\`).join("");

// 分组网格
const out = document.querySelector("#out");
for (const [g, names] of Object.entries(GROUPS)) {
  const items = names.filter(n => ALIAS[n]).map(n => {
    const id = "i-" + ALIAS[n];
    return \`<div class="cell" title="\${n}  →  \${ALIAS[n]}">\` +
      \`<svg class="ico"><use href="#\${id}"/></svg>\` +
      \`<span class="nm">\${ALIAS[n]}</span></div>\`;
  }).join("");
  out.insertAdjacentHTML("beforeend",
    \`<div class="grp"><h2>\${g} · \${names.filter(n=>ALIAS[n]).length}</h2><div class="grid">\${items}</div></div>\`);
}
document.title = "DONE " + Object.keys(ALIAS).length + " icons / " + ICON_COUNT + " symbols";
</script>
</body></html>`;
writeFileSync(`${OUT}/preview.html`, preview, "utf8");

/* ---------- 5. 自检 ---------- */

const checks = [];

// 5a. 预览页内联脚本必须能编译（防止转义漏字）
const inline = preview.match(/<script>([\s\S]*?)<\/script>/);
if (!inline) {
  checks.push("预览页没有 <script>");
} else {
  try {
    new (await import("node:vm")).Script(inline[1]);
  } catch (e) {
    checks.push(`预览页脚本语法错误: ${e.message}`);
  }
}

// 5b. sprite 里不能有重复 id
const spriteIds = [...sprite.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const spriteDupes = spriteIds.filter((x, i) => spriteIds.indexOf(x) !== i);
if (spriteDupes.length) checks.push(`sprite 重复 id: ${[...new Set(spriteDupes)].join(", ")}`);

// 5c. 每个 symbol 必须有 viewBox
for (const s of sprite.matchAll(/<symbol id="([^"]+)"(?![^>]*viewBox)[^>]*>/g)) {
  checks.push(`symbol ${s[1]} 缺 viewBox`);
}

// 5d. 颜色必须走 currentColor，不能有硬编码
const hex = sprite.match(/#[0-9a-fA-F]{6}\b/g);
if (hex) checks.push(`sprite 出现硬编码颜色 ${[...new Set(hex)].join(",")}`);

// 5e. 别名表引用的图标都已下载
for (const [want, kebab] of resolved) {
  if (!namespaced.has(kebab)) checks.push(`别名 ${want} → ${kebab} 未下载`);
}

// 5f. 预览页里的 ICON_COUNT 与实际 symbol 数一致
if (symbols.length !== spriteIds.filter((id) => id.startsWith("i-")).length) {
  checks.push("symbol 计数不一致");
}

console.log("\n自检：" + (checks.length ? "" : "全部通过"));
for (const c of checks) console.log("   ✗ " + c);

console.log(`\n写入：`);
console.log(`  ${OUT}/reicon.svg     ${(sprite.length / 1024).toFixed(1)} KB  ${symbols.length} 个 symbol`);
console.log(`  ${OUT}/icons.ts       ${(ts.length / 1024).toFixed(1)} KB`);
console.log(`  ${OUT}/icons.json`);
console.log(`  ${OUT}/preview.html`);
