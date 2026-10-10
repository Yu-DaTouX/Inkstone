---
name: visual-answer
description: 在砚的图形界面里回答时，内容涉及数值对比或趋势、关键指标、几个候选项的推荐、对象详情、因果或分阶段流程、架构/时序/表关系图，或需要可调参数的示意时使用。说明 yan-chart / yan-stats / yan-cards / yan-record / yan-flow / yan-steps / mermaid / yan-widget 的写法，砚会把它们画成图形。
---

# 结构化回答块

砚会把下面这些代码块画成图形，样式、配色和刻度都由砚决定，你只写数据与文字。先用一两句话给出结论，再放块；块之后可以继续写正文。

什么时候用：
- 两个以上的数值要比较，或有一组随时间变化的数 → `yan-chart`
- 两到六个关键数字（可带涨跌、小趋势线、进度条） → `yan-stats`
- 推荐或对比 2–8 个具体选项（软件、方案、论文） → `yan-cards`
- 一个具体对象的详情（一个包、一台机器、一条记录） → `yan-record`
- 说明几个因素如何共同导致一个结果 → `yan-flow`
- 分阶段或循环的过程，适合一步步点击查看 → `yan-steps`
- 流程图、时序图、类图、数据库表关系、状态机、甘特图 → `mermaid`
- 需要画出机制、带滑块的讲解或插画 → `yan-widget`

什么时候不用：一个数字、一句话能说清的事、纯步骤清单（用普通列表）、数据你没有可靠来源时。不要为了好看而用。

规则：
- 块内只写一个 JSON 对象，不加注释，不写尾逗号。
- 数字必须来自你读到的资料或工具结果，不要编造或估算后当成事实；`source` 写清出处（如「论文表 2」「npm 下载统计 2026-10」）。
- 链接只写你实际看到过的 http(s) 地址。
- 文字短：标题不超过 20 字，说明一两句。

## yan-chart

```yan-chart
{
  "type": "bar",
  "title": "人工测试 vs AI 自行生成测试",
  "subtitle": "同一工作流，SWE-bench Verified",
  "unit": "%",
  "labels": ["AI 生成测试", "人工提供测试"],
  "series": [{ "name": "成功率", "values": [68.0, 94.3] }],
  "stats": [
    { "label": "AI 生成测试", "value": "68.0%", "detail": "平均 $4.12 / 任务" },
    { "label": "人工提供测试", "value": "94.3%", "detail": "平均 $1.01 / 任务" }
  ],
  "source": "论文表 2",
  "note": "人工组拿到了基准中通常隐藏的测试，不等于生产环境。",
  "sources": [{ "label": "ACL Anthology", "url": "https://aclanthology.org/" }]
}
```

- `type`：`bar`（类别比较）、`hbar`（类别名较长的横向柱）、`stacked`（部分占整体的堆叠柱）、`line`（趋势）、`area`（单一趋势）、`dumbbell`（之前/之后，恰好两组）、`diverging`（高于/低于基准，可为负数，只一组）。`labels` 是横轴类别，最多 24 个；`series` 最多 4 组，每组 `values` 个数与 `labels` 相同，只能是数字（除 diverging 外不能为负）。
- `unit` 可选（`%`、`ms`、`$` 等）；`max` 可选，不写时砚自动取整。`stats` 最多 4 个大号数字，可省略。

## yan-cards

```yan-cards
{
  "title": "推荐的 Markdown 编辑器",
  "items": [
    {
      "title": "Typora",
      "badge": "所见即所得",
      "description": "输入后直接显示排版效果，支持表格、代码块和公式。",
      "meta": "付费：一次性买断，15 天试用",
      "links": [{ "label": "官方网站", "url": "https://typora.io" }]
    }
  ]
}
```

- `items` 1–8 个，每个只有 `title` 必填；`links` 最多 4 个。`layout` 为 `list`（默认，一行一个）或 `grid`（并排对比）；最多一个 `"recommended": true`。

## yan-flow

```yan-flow
{
  "join": "plus",
  "steps": [
    { "icon": "agent", "title": "Agent 编写测试", "detail": "TestLoadKeyFromEnv" },
    { "icon": "checklist", "title": "评分器隐藏测试", "detail": "TestLoadKeyFromEnv" }
  ],
  "result": { "tone": "err", "text": "测试函数重复定义 → 编译失败 → 判定任务失败" },
  "note": "这是审查发现的真实错误类型，不代表一定出现在该实验中。"
}
```

- `steps` 1–6 个；`join` 为 `plus`（共同作用）或 `arrow`（先后顺序）。
- `result.tone`：`ok` / `warn` / `err` / `info`。
- `icon` 可选，只能用砚的图标名：agent、checklist、terminal、file、folder、globe、search、shield-check、alert-circle、check-circle、branch、package、key、message-dots、sparkles。不认识的名字会被忽略。

## yan-stats

```yan-stats
{
  "items": [
    { "label": "构建耗时", "value": "28 s", "delta": "-33%", "trend": "down", "good": "down", "spark": [42, 39, 35, 36, 31, 28] },
    { "label": "额度使用", "value": "4.2 / 5", "meter": { "value": 4.2, "max": 5 } }
  ],
  "source": "CI 日志 2026-10"
}
```

- `items` 1–6 个；`trend` 为 `up` / `down` / `flat`，`good` 说明哪个方向是好事（缺省 up），用于涨跌着色。

## yan-record

```yan-record
{ "title": "pi-web-access", "subtitle": "pi 插件 · npm", "badge": "0.37.0",
  "fields": [ { "label": "发布者", "value": "nicobailon" }, { "label": "用途", "value": "网页搜索与抓取" } ],
  "links": [ { "label": "npm", "url": "https://www.npmjs.com/package/pi-web-access" } ] }
```

## yan-steps

```yan-steps
{ "title": "事件循环", "loop": true,
  "steps": [ { "title": "执行同步代码", "body": "调用栈清空前不处理任何回调。" }, { "title": "清空微任务", "body": "Promise 回调全部执行完。" }, { "title": "取一个宏任务", "body": "定时器、I/O 回调等，执行后回到第一步。" } ] }
```

- `steps` 2–10 个；`loop: true` 时最后一步的「下一步」回到第一步。

## mermaid

用标准 mermaid 语法（flowchart、sequenceDiagram、classDiagram、erDiagram、stateDiagram-v2、gantt 等）。节点文字短；一张图 4–12 个节点，太大就拆成几张。

## yan-widget

写一段 HTML/SVG 片段（不需要 html/head/body），在隔离环境离线运行：不能加载任何外部资源，脚本只能用原生 JS。

- 颜色只用变量：`var(--text)` `var(--text-dim)` `var(--text-mute)` `var(--surface)` `var(--surface-2)` `var(--border)` `var(--accent)` `var(--ok)` `var(--warn)` `var(--err)`，分类色 `var(--c1)`…`var(--c6)`；字体 `var(--font)` / `var(--mono)`。深浅主题自动适配。
- SVG 用 `viewBox` 并让宽度自适应；高度由砚自动跟随内容。
- 需要用户追问时调用 `askInkstone("问题")`：砚会在小部件下方显示这句话，用户确认后才填入输入框。
- 页面内的操作不会保存。图表、卡片这类有现成块的内容不要用小部件。

格式写错时砚会按原文显示并提示错误，不会画出图形。
