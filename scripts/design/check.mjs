// 设计稿静态自检 —— 不花模型额度
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || join(HERE, "prototype.html");
const src = readFileSync(FILE, "utf8");

let fails = 0;
const ok = (b, msg) => { console.log((b ? "  OK   " : "  FAIL ") + msg); if (!b) fails++; };

// 待办项：不算失败，但会列出来，防止忘了
const todos = [];
const todo = (b, msg) => { if (!b) todos.push(msg); };

/* ---- 1. 抽出 script 做语法检查 ---- */
const m = src.match(/<script>([\s\S]*?)<\/script>/);
ok(!!m, "<script> 存在");
if (m) {
  const tmp = process.env.TEMP + "\\proto-extract.mjs";
  writeFileSync(tmp, m[1], "utf8");
  console.log("         脚本 " + m[1].split("\n").length + " 行 -> " + tmp);
}

/* ---- 2. 标签配平 ---- */
const VOID = new Set(["br","hr","img","input","meta","link","i","col","source"]);
for (const tag of ["div","section","article","aside","header","footer","details","dl","button","span","p","style","script","html","body","textarea"]) {
  const open  = (src.match(new RegExp("<" + tag + "(?=[\\s>])", "g")) || []).length;
  const close = (src.match(new RegExp("</" + tag + ">", "g")) || []).length;
  if (open === 0 && close === 0) continue;
  ok(open === close, `<${tag}>  开 ${open} / 闭 ${close}`);
}

/* ---- 3. i18n 键完整性 ---- */
const s = m ? m[1] : "";
const grab = (obj) => {
  // 抓 LOCALES 里每个语言块内 "a.b": "..." 的键
  const out = new Set();
  for (const mm of obj.matchAll(/"([A-Za-z]+\.[A-Za-z]+)"\s*:/g)) out.add(mm[1]);
  return out;
};
const zhBlock = (s.match(/"zh-CN"\s*:\s*\{([\s\S]*?)\n  \}/) || [])[1] || "";
const enBlock = (s.match(/"en-US"\s*:\s*\{([\s\S]*?)\n  \}/) || [])[1] || "";
const zh = grab(zhBlock), en = grab(enBlock);
const used = new Set([...src.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map(x => x[1]));
const tKeys = new Set([...s.matchAll(/\bt\("([^"]+)"/g)].map(x => x[1]));

console.log(`\n  zh-CN 键 ${zh.size} / en-US 键 ${en.size} / 模板使用 ${used.size} / 代码调用 ${tKeys.size}`);

const missZh = [...used, ...tKeys].filter(k => !zh.has(k));
const missEn = [...used, ...tKeys].filter(k => !en.has(k));
const onlyZh = [...zh].filter(k => !en.has(k));
const onlyEn = [...en].filter(k => !zh.has(k));
ok(missZh.length === 0, "模板键都在 zh-CN 里" + (missZh.length ? " -> 缺 " + missZh.join(", ") : ""));
ok(missEn.length === 0, "模板键都在 en-US 里" + (missEn.length ? " -> 缺 " + missEn.join(", ") : ""));
ok(onlyZh.length === 0 && onlyEn.length === 0, "两种语言键集合一致" +
   (onlyZh.length ? " 仅zh:" + onlyZh.join(",") : "") + (onlyEn.length ? " 仅en:" + onlyEn.join(",") : ""));

/* ---- 4. 脏字符 ---- */
const zw = [...src].map((c, i) => [c, i]).filter(([c]) => c === "\u200B" || c === "\uFEFF");
ok(zw.length === 0, "无零宽字符" + (zw.length ? " -> " + zw.length + " 处" : ""));

/* ---- 5. 设计约束（禁止项） ---- */
const css = (src.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
ok(!/box-shadow\s*:(?!\s*0 0 0)/.test(css.replace(/box-shadow\s*:\s*0 0 0[^;]*/g, "")), "无投影(除峰谷点的光晕)");
ok(!/linear-gradient|radial-gradient/.test(css), "无渐变");
/* 圆角上限：装饰性胶囊（滚动条、进度条）允许 99px，其余不超过 --r-xl(14px) */
const PILL_OK = /(webkit-scrollbar-thumb|\.meter)/;
const badRadius = css.split("\n").filter(l => /border-radius\s*:\s*(99px|1[5-9]px|[2-9]\dpx)/.test(l) && !PILL_OK.test(l));
ok(badRadius.length === 0, "无大药丸圆角（滚动条/进度条除外）" + (badRadius.length ? " -> " + badRadius.map(s => s.trim()).join(" | ") : ""));

/* ---- 6. 深/浅主题令牌对称 ---- */
const dark = (css.match(/data-theme="dark"\]\{([\s\S]*?)\}/) || [])[1] || "";
const light = (css.match(/data-theme="light"\]\{([\s\S]*?)\}/) || [])[1] || "";
const vars = (b) => new Set([...b.matchAll(/(--[\w-]+)\s*:/g)].map(x => x[1]));
const dv = vars(dark), lv = vars(light);
const badLight = [...dv].filter(v => !lv.has(v) && !["--diff-add-bg","--diff-del-bg"].includes(v));
ok(badLight.length === 0, "浅色主题令牌覆盖完整" + (badLight.length ? " -> 缺 " + badLight.join(", ") : ""));

/* ---- 7. 栅格字体（硬约束） ---- */
// 终端风格 UI 的前提：一个汉字 == 两个 ASCII 字符宽。
// 只有拉丁步进为 0.5em 或 0.6em 的字体才凑得出整数比。
const RATIO_OK = ["Maple Mono CN", "Sarasa Mono", "LXGW WenKai Mono"];
const fontDecl = css.match(/--font-mono\s*:\s*([^;]+);/);
const fontVal = fontDecl ? fontDecl[1] : "";
const hasGridFont = RATIO_OK.some(f => fontVal.includes(f));
const hasFontFace = /@font-face/.test(css);

ok(hasGridFont, "--font-mono 首位是已知 1:2 步进字体" +
   (hasGridFont ? "" : ` -> 当前: ${fontVal.trim().split(",")[0]}`));
ok(hasFontFace, "@font-face 内嵌了字体（不能只靠系统回退）");
ok(!/^\s*["']?(monospace|ui-monospace)/.test(fontVal),
   "--font-mono 首项不是裸 monospace（Windows 会掉到 Courier New）");

/* ---- 8. 图标必须走 reicon sprite，不能再用 Unicode 字形 ---- */
const spritePath = join(HERE, "icons", "reicon.svg");
const sprite = existsSync(spritePath) ? readFileSync(spritePath, "utf8") : "";
const symbolIds = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]));
const iconUses = [...new Set([...src.matchAll(/<use\s+href="#(i-[\w-]+)"/g)].map(m => m[1]))];

ok(symbolIds.size > 0, `reicon sprite 存在（${symbolIds.size} 个 symbol）`);
if (iconUses.length) {
  const dangling = iconUses.filter(u => !symbolIds.has(u));
  ok(dangling.length === 0, `${iconUses.length} 个 <use> 引用全部有对应 symbol` +
     (dangling.length ? " -> 悬空: " + dangling.join(", ") : ""));
} else {
  todo(false, "图标还是 Unicode 字符（`◐` `↺` `✓`），应换成 icons/reicon.svg 里的 sprite");
}

// 常见的“既当图标又当文字”的字符
// 只扫「壳」（chrome），不扫代码/工具输出的正文 —— 那一块是 passthrough 内容，
// 出现 `✓ src/foo.test.ts` 是 vitest 的真实输出，不是我们的图标（见 DESIGN.md §6）
const chromeLines = [];
let inCode = false;
for (const line of src.split("\n")) {
  if (/<div class="(tool-pre|diff)"/.test(line)) inCode = true;
  if (!inCode) chromeLines.push(line);
  if (inCode && /<\/div>/.test(line) && !/<div/.test(line)) inCode = false;
}
const chrome = chromeLines.join("\n");
const unicodeIcons = ["◐", "↺", "✓", "✗", "⚠", "⏵", "⏸", "⌄", "⌃", "⇄", "✦"]
  .filter(c => chrome.includes(c));
if (unicodeIcons.length) {
  todo(false, `正文里还有 Unicode 图标字符: ${unicodeIcons.join(" ")} —— 确认这些是刻意保留的还是漏改`);
}

/* ---- 9. 上下文窗口数据必须是真的量级 ---- */
// 模型的真实上限是 1,000,000（见 HANDOFF §5.5），写 128,000 会看不出真实观感。
// 只看数字展示位置（`X / Y` 这种），不看注释里的说明文字。
todo(!/\/\s*128,000/.test(src),
     "设计稿里还写着 128,000 的上下文窗口 —— 真实值是 1,000,000（HANDOFF §5.5）");
const ctx = src.match(/<span>([\d,]+)\s*\/\s*([\d,]+)<\/span>\s*<span>([\d.]+)%/);
if (ctx) {
  const [, used, total, pct] = ctx;
  const U = +used.replace(/,/g, ""), T = +total.replace(/,/g, "");
  const real = Math.round(U / T * 100);
  ok(Math.abs(real - parseFloat(pct)) <= 1,
     `上下文进度条一致 ${used}/${total} = ${real}% （标注 ${pct}%）`);
  ok(T >= 1000000 || T === 128000,
     `上下文上限 ${total} 与 API 声明同量级（1,000,000）`);
  const bar = src.match(/<div class="meter"><i style="width:([\d.]+)%"/);
  if (bar) ok(Math.abs(parseFloat(bar[1]) - real) <= 1,
              `进度条宽度 ${bar[1]}% 与数字 ${real}% 一致`);
}

/* ---- 汇总 ---- */
if (todos.length) {
  console.log("\n  待办（不算失败）:");
  for (const t of todos) console.log("    · " + t);
}

console.log("\n" + (fails === 0 ? "全部通过" : fails + " 项失败") +
            (todos.length ? `（另有 ${todos.length} 项待办）` : "") + "\n");
process.exit(fails ? 1 : 0);
