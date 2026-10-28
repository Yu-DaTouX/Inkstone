---
name: visual-answer
description: 写 yan-chart、yan-stats、yan-cards 等回答块、mermaid 图或 yan-widget 小部件前读取，含各块字段格式、多种场景范例与小部件写法。
---

# 结构化回答块

砚会把下面这些代码块画成图形，嵌在回答正文里，样式、配色和刻度都由砚决定，你只写数据与文字。块放在正文里它所说明的位置，前后正文接着讲；不要预告「下面是一张图」，也不要把块里的内容再用文字复述一遍。

砚的风格是安静的：块没有外框和底色，用细线分隔，字号跟正文一致。块要小而准，一个块只回答一个问题；一次回答通常一个块，最多两个，别让整页都是图。

选哪一种：
- 数值比较，或一组随时间变化的数 → `yan-chart`
- 两到六个关键数字（可带涨跌、小趋势线、进度条） → `yan-stats`
- 推荐或对比 2–8 个具体选项（软件、方案、论文） → `yan-cards`
- 一个具体对象的详情（一个包、一台机器、一条记录） → `yan-record`
- 几个因素如何共同导致一个结果，或一条短链路 → `yan-flow`
- 分阶段或循环的过程（编号时间线） → `yan-steps`
- 流程图、时序图、类图、数据库表关系、状态机、甘特图 → `mermaid`
- 需要拖动、切换或动画才能讲清的机制 → `yan-widget`

什么时候不用：一个数字、一句话能说清的事、普通的操作步骤（用列表）、数据没有可靠来源时、代码改动总结与测试结果。

规则：
- 块是 Markdown 围栏代码块，语言名就是块名（如 ```` ```yan-stats ````）；写成 `<yan-stats>` 这样的标签不会被画出来。
- 块内只写一个 JSON 对象，不加注释，不写尾逗号。
- 数字必须来自你读到的资料或工具结果，不要编造或估算后当成事实；`source` 写清出处（如「论文表 2」「npm 下载统计 2026-10」）。
- 链接只写你实际看到过的 http(s) 地址。
- 文字短：标题不超过 20 字，说明一两句；能省的字段就省。
- 画的量要和标题、`series.name`、`unit` 一致：比耗时就画耗时（subtitle 写「越低越好」），比倍数就把标题写成倍数。

## yan-chart

类别比较，单组数据会在柱顶标数值：

```yan-chart
{ "type": "bar", "title": "冷启动耗时", "subtitle": "越低越好", "unit": "ms",
  "labels": ["Electron", "Tauri", "原生"], "series": [{ "name": "耗时", "values": [820, 310, 140] }],
  "source": "本机实测 5 次取中位数" }
```

趋势，多组时自动出图例，折线末端标最新值：

```yan-chart
{ "type": "line", "title": "周活跃用户", "unit": "千",
  "labels": ["W1", "W2", "W3", "W4", "W5", "W6"],
  "series": [{ "name": "桌面", "values": [12.1, 12.8, 13.5, 13.2, 14.6, 15.3] }, { "name": "手机", "values": [3.2, 3.9, 4.8, 5.6, 6.1, 7.0] }],
  "source": "埋点报表 2026-10" }
```

类别名较长用横向柱；结论数字放 `stats`：

```yan-chart
{ "type": "hbar", "title": "依赖体积", "unit": "MB",
  "labels": ["@electron/rebuild", "typescript", "mermaid", "react-dom"],
  "series": [{ "name": "体积", "values": [18.4, 22.1, 9.6, 4.3] }],
  "stats": [{ "label": "合计", "value": "54.4 MB" }, { "label": "最大", "value": "typescript" }],
  "source": "du -sh node_modules/*" }
```

高于/低于基准：

```yan-chart
{ "type": "diverging", "title": "各模块覆盖率相对目标", "unit": "pt",
  "labels": ["main", "renderer", "shared", "mobile"], "series": [{ "name": "差值", "values": [6, -4, 12, -9] }],
  "source": "覆盖率报告 2026-10", "note": "目标 80%" }
```

- `type`：`bar`、`hbar`、`stacked`（部分占整体）、`line`、`area`（单一趋势）、`dumbbell`（之前/之后，恰好两组）、`diverging`（可为负数，只一组）。`labels` 最多 24 个；`series` 最多 4 组，`values` 个数与 `labels` 相同，只能是数字（除 diverging 外不能为负）。
- `source` 必填。`unit` 可选；`max` 可选，不写时砚自动取整。折线的纵轴按数据范围取，不必从 0 开始。`stats` 最多 4 个，可省略。

## yan-stats

一排关键数字，竖细线分隔。带涨跌和小趋势：

```yan-stats
{ "items": [
  { "label": "构建耗时", "value": "28 s", "delta": "-33%", "trend": "down", "good": "down", "spark": [42, 39, 35, 36, 31, 28] },
  { "label": "包体积", "value": "96 MB", "delta": "+2 MB", "trend": "up", "good": "down" },
  { "label": "测试", "value": "412", "detail": "全部通过" } ],
  "source": "CI 日志 2026-10" }
```

额度与占用，进度到 85% 变黄、95% 变红：

```yan-stats
{ "items": [
  { "label": "本月额度", "value": "4.2 / 5", "meter": { "value": 4.2, "max": 5 } },
  { "label": "磁盘", "value": "466 GB", "meter": { "value": 466, "max": 512 }, "detail": "剩 46 GB" } ] }
```

- `items` 1–6 个；`trend` 为 `up` / `down` / `flat`，`good` 说明哪个方向是好事（缺省 up）。`spark` 至少 2 个数，只放真实的逐期数据；只知道起点和终点时不写 `spark`，不要补中间值。

## yan-cards

并排对比，`grid` 布局，可标一个推荐：

```yan-cards
{ "title": "本地向量库", "layout": "grid", "items": [
  { "title": "SQLite + sqlite-vec", "badge": "零依赖", "description": "单文件，适合十万条以内。", "meta": "暴力检索", "recommended": true },
  { "title": "LanceDB", "badge": "列存", "description": "磁盘索引，百万级仍快。", "meta": "多一个原生依赖" },
  { "title": "Qdrant", "badge": "服务", "description": "功能最全，需要单独进程。", "meta": "部署成本高" } ] }
```

推荐清单，`list` 布局，一行一个、带序号：

```yan-cards
{ "title": "值得先读的三篇", "items": [
  { "title": "Attention Is All You Need", "description": "Transformer 的出处。", "meta": "2017 · NeurIPS", "links": [{ "label": "arXiv", "url": "https://arxiv.org/abs/1706.03762" }] },
  { "title": "Scaling Laws for Neural Language Models", "description": "参数、数据与算力的幂律。", "meta": "2020 · OpenAI" } ] }
```

- `items` 1–8 个，只有 `title` 必填；`links` 最多 4 个；最多一个 `"recommended": true`。

## yan-record

一个对象的档案，字段自动排成几列：

```yan-record
{ "title": "pi-web-access", "subtitle": "pi 插件 · npm", "badge": "0.37.0",
  "fields": [ { "label": "发布者", "value": "nicobailon" }, { "label": "周下载", "value": "1.2k" }, { "label": "许可", "value": "MIT" } ],
  "links": [ { "label": "npm", "url": "https://www.npmjs.com/package/pi-web-access" } ] }
```

```yan-record
{ "title": "build-03", "subtitle": "CI 机器 · Windows 11", "badge": "空闲",
  "fields": [ { "label": "CPU", "value": "16 核" }, { "label": "内存", "value": "64 GB" }, { "label": "上次任务", "value": "12 分钟前" } ],
  "note": "每晚 2 点自动重启。" }
```

## yan-flow

几个因素叠加成一个结果（`plus`，结果前显示 =）：

```yan-flow
{ "join": "plus",
  "steps": [ { "title": "网络跨区", "detail": "+120ms" }, { "title": "代理排队", "detail": "+80ms" }, { "title": "缓存未命中", "detail": "+150ms" } ],
  "result": { "tone": "err", "text": "首字延迟超过 600ms" } }
```

一条短链路（`arrow`）：

```yan-flow
{ "join": "arrow",
  "steps": [ { "icon": "file", "title": "保存文件" }, { "icon": "terminal", "title": "触发构建" }, { "icon": "check-circle", "title": "热更新" } ],
  "result": { "tone": "ok", "text": "约 0.4 秒看到改动" } }
```

- `steps` 1–6 个；`result.tone`：`ok` / `warn` / `err` / `info`，只决定结果前小圆点的颜色。
- `icon` 可选：agent、checklist、terminal、file、folder、globe、search、shield-check、alert-circle、check-circle、branch、package、key、message-dots、sparkles。不认识的名字会被忽略。

## yan-steps

编号时间线，每步一行标题加一句说明：

```yan-steps
{ "title": "一次请求", "steps": [
  { "title": "组装请求", "body": "拼接系统提示、历史和工具定义。" },
  { "title": "命中缓存", "body": "前缀一致的部分按缓存价计费。" },
  { "title": "流式返回", "body": "逐块推送到客户端。" } ] }
```

```yan-steps
{ "title": "事件循环", "loop": true, "steps": [
  { "title": "执行同步代码", "body": "调用栈清空前不处理回调。" },
  { "title": "清空微任务", "body": "Promise 回调全部执行完。" },
  { "title": "取一个宏任务", "body": "定时器、I/O 回调等。" } ] }
```

- `steps` 2–10 个；`loop: true` 表示最后一步之后回到第一步。

## mermaid

用标准 mermaid 语法（flowchart、sequenceDiagram、classDiagram、erDiagram、stateDiagram-v2、gantt 等）。节点文字短；一张图 4–10 个节点，太大就拆。流程图不超过 5 个节点用 `flowchart LR`，更多用 `flowchart TD`；横向太宽时文字会被缩小。

## yan-widget

写一段 HTML/SVG 片段（不需要 html/head/body），在隔离环境离线运行：不能加载任何外部资源，脚本只能用原生 JS。

- 颜色只用变量：`var(--text)` `var(--text-dim)` `var(--text-mute)` `var(--surface)` `var(--surface-2)` `var(--border)` `var(--border-strong)` `var(--accent)` `var(--ok)` `var(--warn)` `var(--err)`，分类色 `var(--c1)`…`var(--c6)`；字体 `var(--font)` / `var(--mono)`。shadcn 风格的 `--background` `--foreground` `--muted` `--primary` `--chart-1`…也可用。深浅主题自动适配。
- 小部件直接铺在正文里，字号与正文相同：最外层不要背景色、卡片边框、横幅标题或左右留白；分隔用 1px `var(--border)` 细线；局部需要底色时用 `var(--surface-2)`、`var(--radius)` 圆角。按钮已有默认样式，直接写 `<button>`。
- 要矮：整体高度一般 120–260px，图表给固定像素高度；不要用 `vh`，也不要在 html、body 上写 `height:100%`。
- 需要用户追问时调用 `askInkstone("问题")`：砚会在小部件下方显示这句话，用户确认后才填入输入框。
- 需要保留状态时，由小部件主动调用 `inkstoneSaveState(可 JSON 序列化的值)`，并监听 `inkstone:restore` 事件，从 `detail` 恢复。状态只缓存在内存，单份上限 64 KB，应用重载后不保证恢复。图表、卡片这类有现成块的内容不要用小部件。

下面五种写法可以直接改着用。

参数计算器：拖动一个量，看另一个量怎么变。

```yan-widget
<style>.row{display:flex;gap:12px;align-items:center}.row input{flex:1}.out{display:flex;gap:24px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)}.out b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.out span{color:var(--text-mute);font-size:12px}</style>
<label class="row">缓存命中率 <input id="hit" type="range" min="0" max="100" value="70"> <span id="hv">70%</span></label>
<div class="out"><div><b id="cost">0.37×</b><span>每轮相对成本</span></div><div><b id="save">63%</b><span>节省</span></div></div>
<script>const h=document.getElementById('hit');function u(){const p=+h.value/100,c=1-p*0.9;hv.textContent=h.value+'%';cost.textContent=c.toFixed(2)+'×';save.textContent=Math.round((1-c)*100)+'%'}h.oninput=u;u()</script>
```

方案切换：同一组指标，点不同方案看差别。

```yan-widget
<style>.tabs{display:flex;gap:6px}.tabs button[aria-pressed=true]{background:var(--text);color:var(--bg);border-color:var(--text)}.m{display:grid;grid-template-columns:72px 1fr 48px;gap:6px 10px;align-items:center;margin-top:12px}.bar{height:8px;border-radius:2px;background:var(--c1)}.v{text-align:right;font-variant-numeric:tabular-nums;color:var(--text-dim)}</style>
<div class="tabs" id="t"></div><div class="m" id="m"></div>
<script>const D={直连:{延迟:420,成本:30,稳定:90},经代理:{延迟:610,成本:34,稳定:97}},MAX={延迟:800,成本:50,稳定:100};let cur='直连';function r(){t.innerHTML=Object.keys(D).map(k=>`<button aria-pressed=${k===cur}>${k}</button>`).join('');[...t.children].forEach(b=>b.onclick=()=>{cur=b.textContent;r()});m.innerHTML=Object.entries(D[cur]).map(([k,v])=>`<span>${k}</span><div class="bar" style="width:${v/MAX[k]*100}%"></div><span class="v">${v}</span>`).join('')}r()</script>
```

时间轴：横向刻度上标出几个事件，点击看说明。

```yan-widget
<style>svg{display:block;width:100%;height:56px}circle{cursor:pointer}#d{margin:4px 0 0;color:var(--text-dim)}</style>
<svg viewBox="0 0 600 56"><line x1="10" y1="20" x2="590" y2="20" stroke="var(--border-strong)"/><g id="g"></g></svg><p id="d">点一个节点</p>
<script>const E=[[0,'2017','Transformer 提出'],[0.35,'2020','缩放定律'],[0.65,'2022','指令微调普及'],[1,'2025','长上下文与工具调用']];g.innerHTML=E.map(([x,y],i)=>`<circle cx="${10+x*580}" cy="20" r="6" fill="var(--c${i+1})" data-i="${i}"/><text x="${10+x*580}" y="48" font-size="12" fill="var(--text-mute)" text-anchor="${x===0?'start':x===1?'end':'middle'}">${y}</text>`).join('');g.onclick=e=>{const i=e.target.dataset.i;if(i)d.textContent=E[i][1]+'：'+E[i][2]}</script>
```

机制图：几个部件加连线，点按钮让过程走一遍。

```yan-widget
<style>svg{display:block;width:100%;height:120px}.box{fill:none;stroke:var(--border-strong)}.lab{font-size:13px;fill:var(--text);text-anchor:middle}.dot{fill:var(--accent)}</style>
<svg viewBox="0 0 600 120"><rect class="box" x="10" y="40" width="120" height="40" rx="6"/><text class="lab" x="70" y="65">客户端</text><rect class="box" x="240" y="40" width="120" height="40" rx="6"/><text class="lab" x="300" y="65">代理</text><rect class="box" x="470" y="40" width="120" height="40" rx="6"/><text class="lab" x="530" y="65">模型</text><line x1="130" y1="60" x2="240" y2="60" stroke="var(--border-strong)"/><line x1="360" y1="60" x2="470" y2="60" stroke="var(--border-strong)"/><circle id="p" class="dot" cx="130" cy="60" r="5" opacity="0"/></svg>
<button id="go">发送一次请求</button>
<script>go.onclick=()=>{p.setAttribute('opacity',1);p.animate([{transform:'translateX(0)'},{transform:'translateX(340px)'}],{duration:1200,easing:'ease-in-out'}).onfinish=()=>p.setAttribute('opacity',0)}</script>
```

前后对比：同一段内容改前、改后切换着看。

```yan-widget
<style>.sw{display:flex;gap:6px;margin-bottom:8px}.sw button[aria-pressed=true]{background:var(--text);color:var(--bg);border-color:var(--text)}pre{margin:0;padding:12px 16px;border-radius:var(--radius);background:var(--surface-2);font:12px/1.6 var(--mono);white-space:pre-wrap}</style>
<div class="sw"><button aria-pressed="true" data-k="a">改前</button><button aria-pressed="false" data-k="b">改后</button></div><pre id="c"></pre>
<script>const T={a:'for (const f of files) {\n  await upload(f)\n}',b:'await Promise.all(files.map(upload))'};const s=document.querySelector('.sw');function show(k){c.textContent=T[k];[...s.children].forEach(b=>b.setAttribute('aria-pressed',b.dataset.k===k))}s.onclick=e=>{if(e.target.dataset.k)show(e.target.dataset.k)};show('a')</script>
```

格式写错时砚会按原文显示并提示错误，不会画出图形。
