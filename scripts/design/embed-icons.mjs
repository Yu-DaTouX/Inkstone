/**
 * embed-icons.mjs —— 把 reicon sprite 里「本文件真正用到」的 symbol 子集，
 * 内联进 prototype.html 的 ICON-SPRITE 标记之间。
 *
 * 为什么内联而不是外链：
 *   Chromium 在 file:// 下会拦截跨文件 SVG `<use href="reicon.svg#id">`，
 *   设计稿要求「双击就能打开」，所以必须同文档内联。
 *   而整份 sprite 有 239KB / 166 个 symbol，全贴进去会把设计稿撑到 280KB，
 *   因此只抽引用到的子集（约 30–40 个，~50KB）。
 *
 * 用法：
 *   node scripts/design/embed-icons.mjs            # 写入
 *   node scripts/design/embed-icons.mjs --check    # 只校验，不写文件
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO = join(HERE, "prototype.html");
const SPRITE = join(HERE, "icons", "reicon.svg");

/** 运行时用 JS 切换、静态扫描扫不到的图标，必须在这里登记 */
const RUNTIME_ICONS = ["i-folder", "i-folder-open", "i-sun", "i-moon"];

const START = "<!-- ICON-SPRITE-START -->";
const END = "<!-- ICON-SPRITE-END -->";

const html = readFileSync(PROTO, "utf8");
const sprite = readFileSync(SPRITE, "utf8");

const symbols = new Map(
  [...sprite.matchAll(/<symbol id="([^"]+)"[\s\S]*?<\/symbol>/g)].map(m => [m[1], m[0]])
);

// 引用来源：静态 <use>、JS 里 setAttribute("href", "#i-...") 的字符串、登记表
const used = new Set([
  ...[...html.matchAll(/<use\s+href="#([\w-]+)"/g)].map(m => m[1]),
  ...[...html.matchAll(/["']#(i-[\w-]+)["']/g)].map(m => m[1]),
  ...RUNTIME_ICONS,
]);

const missing = [...used].filter(id => !symbols.has(id));
if (missing.length) {
  console.error("引用了 sprite 里不存在的图标: " + missing.join(", "));
  process.exit(1);
}

// 按 sprite 原始顺序输出，diff 才稳定（别按引用顺序，那样加一处引用就整段重排）
const picked = [...symbols.keys()].filter(id => used.has(id));
const out =
  `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">` +
  picked.map(id => symbols.get(id)).join("") +
  `</svg>`;

const i = html.indexOf(START), j = html.indexOf(END);
if (i < 0 || j < 0) { console.error(`找不到标记 ${START} / ${END}`); process.exit(1); }

const next = html.slice(0, i + START.length) + "\n" + out + "\n" + html.slice(j);

const kb = (s) => (Buffer.byteLength(s, "utf8") / 1024).toFixed(1) + " KB";
console.log(`引用 ${used.size} 个图标 -> 内联 ${picked.length} 个 symbol（${kb(out)}）`);
console.log(`prototype.html  ${kb(html)} -> ${kb(next)}`);

if (process.argv.includes("--check")) {
  console.log(html === next ? "已是最新，无需写入" : "需要重新生成（跑一次不带 --check 的）");
} else if (html !== next) {
  writeFileSync(PROTO, next, "utf8");
  console.log("已写入 " + PROTO);
} else {
  console.log("无变化，未写入");
}
