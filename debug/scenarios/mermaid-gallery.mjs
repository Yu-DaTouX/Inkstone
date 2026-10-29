import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: 'Mermaid 多图类型画廊：合成消息，深浅主题逐图截图（MERMAID_SHOT_DIR、MERMAID_SHOT_TAG 可指定输出）' }

const DIAGRAMS = {
  flowchart: `flowchart LR
  A[用户输入] --> B{需要工具?}
  B -- 是 --> C[调用工具]
  B -- 否 --> D[直接回答]
  C --> E[整理结果]
  E --> D
  subgraph 渲染
    D --> F((SVG))
  end`,
  sequence: `sequenceDiagram
  participant U as 用户
  participant R as 渲染端
  participant M as 主进程
  U->>R: 发送消息
  R->>M: IPC 请求
  activate M
  M-->>R: 流式事件
  deactivate M
  Note over R,M: 会话归属核对
  R-->>U: 显示回答`,
  class: `classDiagram
  class Session {
    +string id
    +string cwd
    +send(text) bool
  }
  class Message {
    +string role
    +string text
  }
  class ToolCall {
    +string name
    +status
  }
  Session "1" --> "*" Message
  Message o-- ToolCall
  Animal <|-- Duck`,
  state: `stateDiagram-v2
  [*] --> Idle
  Idle --> Streaming: send
  Streaming --> Tool: tool_call
  Tool --> Streaming: result
  Streaming --> Idle: done
  Streaming --> Error: fail
  Error --> [*]`,
  gantt: `gantt
  title 发布计划
  dateFormat YYYY-MM-DD
  section 开发
  渲染替换 :a1, 2026-10-01, 5d
  主题对接 :after a1, 3d
  section 验收
  截图对照 :2026-10-09, 2d
  体积统计 :2026-10-10, 1d`,
  pie: `pie title 渲染端分块体积
  "index" : 42
  "mermaid" : 35
  "codemirror" : 15
  "其他" : 8`,
  er: `erDiagram
  SESSION ||--o{ MESSAGE : contains
  MESSAGE ||--o{ TOOL_CALL : has
  SESSION {
    string id PK
    string cwd
  }
  MESSAGE {
    string id PK
    string role
  }`,
  mindmap: `mindmap
  root((砚))
    会话
      子代理
      压缩
    界面
      深色
      浅色
    渲染
      Mermaid
      图表`,
  timeline: `timeline
  title 版本历史
  2026-08 : 0.11 会话为主入口
  2026-09 : 0.12 子代理
  2026-10 : 0.13 图表渲染`,
  journey: `journey
  title 用户画图
  section 提问
    输入需求: 5: 用户
    模型回答: 3: 模型
  section 查看
    放大查看: 4: 用户
    保存 SVG: 4: 用户`,
  gitGraph: `gitGraph
  commit
  branch feature
  checkout feature
  commit
  commit
  checkout main
  merge feature
  commit`,
  xychart: `xychart-beta
  title "每周会话数"
  x-axis [w1, w2, w3, w4]
  y-axis "次数" 0 --> 100
  bar [20, 45, 60, 80]
  line [20, 45, 60, 80]`,
  quadrant: `quadrantChart
  title 优先级
  x-axis 低成本 --> 高成本
  y-axis 低收益 --> 高收益
  quadrant-1 计划
  quadrant-2 立即做
  quadrant-3 放弃
  quadrant-4 再议
  渲染替换: [0.3, 0.8]
  重写外壳: [0.9, 0.4]`,
  invalid: `flowchart LR
  A -->`
}

export default async function run({ cdp, newSession, check, sleep, report, runDir }) {
  const dir = process.env.MERMAID_SHOT_DIR || runDir
  const tag = process.env.MERMAID_SHOT_TAG || 'shot'
  mkdirSync(dir, { recursive: true })
  await newSession()
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'light', lang: 'zh-CN', rightPanelOpen: false })`)
  const names = Object.keys(DIAGRAMS)
  const messages = [{ id: 'mg-user', role: 'user', text: '画几种图', timestamp: Date.now() - 5000 }]
  for (const name of names) messages.push({ id: `mg-${name}`, role: 'assistant', text: `**${name}**\n\n\`\`\`mermaid\n${DIAGRAMS[name]}\n\`\`\``, timestamp: Date.now() })
  await cdp.evaluate(`window.__yanStore.setState({ messages: ${JSON.stringify(messages)}, historyLoading: false, switchLoading: false })`)
  const results = {}
  for (const theme of ['light', 'dark']) {
    await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: ${JSON.stringify(theme)} })`)
    await sleep(800)
    for (const name of names) {
      const located = await cdp.evaluate(`(() => {
        const blocks = Array.from(document.querySelectorAll('.v3-visual-mermaid, .v3-visual-invalid, .v3-visual-pending'));
        const idx = ${names.indexOf(name)};
        const el = blocks[idx];
        if (!el) return null;
        el.style.scrollMarginTop = '96px'; el.scrollIntoView({ block: 'start' });
        return true
      })()`)
      await sleep(500)
      for (let attempt = 0; attempt < 6; attempt++) {
        const top = await cdp.evaluate(`(() => { const el = Array.from(document.querySelectorAll('.v3-visual-mermaid, .v3-visual-invalid, .v3-visual-pending'))[${names.indexOf(name)}]; if (!el) return 0; const r = el.getBoundingClientRect(); if (r.top >= 0 && r.top < innerHeight / 2) return r.top; el.style.scrollMarginTop = '96px'; el.scrollIntoView({ block: 'start' }); return -1 })()`)
        if (top >= 0) break
        await sleep(400)
      }
      const info = await cdp.evaluate(`(() => {
        const blocks = Array.from(document.querySelectorAll('.v3-visual-mermaid, .v3-visual-invalid, .v3-visual-pending'));
        const el = blocks[${names.indexOf(name)}];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const svg = el.querySelector('svg');
        return { kind: el.className, x: r.x, y: r.y, w: r.width, h: r.height, svgW: svg?.getBoundingClientRect().width ?? 0, svgH: svg?.getBoundingClientRect().height ?? 0, error: el.querySelector('.v3-visual-invalid-note')?.textContent ?? null, texts: svg ? svg.querySelectorAll('text, foreignObject').length : 0 }
      })()`)
      results[`${theme}/${name}`] = info
      if (located && info) {
        const res = await cdp.call('Page.captureScreenshot', { format: 'png' })
        writeFileSync(join(dir, `${tag}-${theme}-${name}.png`), Buffer.from(res.result.data, 'base64'))
      }
      check(`${theme}/${name} 有输出`, !!info, info)
    }
  }
  report.results = results
  writeFileSync(join(dir, `${tag}-results.json`), JSON.stringify(results, null, 2))
}
