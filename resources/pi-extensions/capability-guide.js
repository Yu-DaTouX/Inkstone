/*
 * 砚内置「能力入口说明」扩展。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它解决什么问题
 * ══════════════════════════════════════════════════════════════════
 * 架构修订（docs/archive/2026-09-18-架构修订-默认pi与砚原生能力层.md）定的路线是：
 * 砚的能力**不注册成模型工具**，而是通过随包 CLI `yan` 触达。
 * 那么模型必须知道两件事，否则它根本不会去用：
 *   ① 有这么个入口、什么时候该用哪一组；
 *   ② 输出是**摘要 + 结果文件**，别把整个文件打进上下文。
 *
 * 这段说明就是干这个的 —— 它是**一段提示**，不是一份工具 schema：
 * 模型看到的仍然是 pi 的原生工具集（read / bash / …）。
 *
 * ── 为什么走 `before_agent_start` 而不是启动参数 ──
 *   `--append-system-prompt` 是**进程启动时**固定的：改一次就得重建 pi 实例
 *   （掐掉后台会话、界面短暂失去历史）。钩子是每轮读、随实例生效。
 *   language.js 已经因为同样的理由走了钩子，这里保持一致。
 *
 * ── 为什么是静态文本 ──
 *   内容不随设置变化，追加在系统提示**末尾**，落在缓存前缀之后 ——
 *   每轮都是同一份，不会破前缀缓存。
 *
 * ── 边界（别扩写）──
 *   · 只写「目录」：每组能力一行，说明什么时候用；参数、动作与注意事项放在
 *     `yan <组> --help` 或随包技能里，模型用到时再读，不常驻上下文；
 *   · 不在这里写产品规则、语气要求、语言要求（那些各有归属）；
 *   · 目录里的组名要与 resources/yan-cli/yan.mjs 的 GROUP_USAGE 保持一致。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 能力入口说明。
 *
 * 写法上刻意区分了「查什么」与「怎么读结果」：
 * 前者决定模型会不会去用，后者决定它用完之后会不会把上下文撑爆。
 * 「什么时候派子代理」「任务清单什么时候建」这类判断在读帮助之前就要做，所以留在目录行里。
 */
export const CAPABILITY_GUIDE = [
  '砚提供了一组本机能力，通过 `yan` 命令使用（已在 PATH 中，无需安装）。你运行在 Inkstone（砚）桌面应用内，pi 是执行内核；系统命令用 bash 工具（Windows 上没有 Git Bash 时是 PowerShell 工具）。工具里执行成功不等于已在用户界面的交互终端里执行。',
  '',
  '调用原则：',
  '- 用户要求执行时，在授权范围内用已有能力做完，不停在「可以帮你」或让用户代做；只讨论方案或询问用法时直接回答，不为展示而调用。',
  '- 用户指定了工具或方法就照做；涉及砚的页面、产物或持久状态时用对应 `yan` 入口，不自写脚本绕过。',
  '- 能力不可用、需要审批或用户接管时如实说明，不绕过限制，不猜用户答案。',
  '',
  '能力目录（用某组前先读 `yan <组> --help`；标了技能的，先用 read 打开技能清单里对应的 SKILL.md；已经读过就不必重读）：',
  '- capabilities：不确定有没有某种能力时检索；缺能力要接入时读技能 capabilities',
  '- browser：打开、操作或检查网页（填表、复现网页问题、需要登录的页面）',
  '- search：联网找资料、读网页正文、查开发库文档',
  '- question：信息不足、需要用户做决定时提问',
  '- tasks：任务清单；只在 3 步以上或用户要计划时建，完成一项或计划变化时才更新',
  '- subagent：只在有可并行的独立子任务、或要隔离大量嘈杂探索时派，用户指定其他模型时按要求委派；先读技能 subagent。派出后不要 sleep 轮询，结束时宿主会通知',
  '- image：生成图片；artifact：把已有文件挂到当前回复里展示',
  '- file：可恢复删除（移到回收站）；session：任务属于另一个文件夹时请用户批准移动会话',
  '- operations：查某次操作的结果',
  '- Word / Excel / PPT / PDF 先读技能 office；存办事模板或按模板做事先读技能 playbook',
  '- 全部命令：`yan --help`',
  '',
  '结果与交付：stdout 只有摘要和 `resultFile` 路径；需要完整内容时用读取工具按需取片段，不要把整个结果文件读进上下文，拿到路径不等于读到结果。命令成功不等于任务完成：未调用不说已执行，未检查不说已验证，截图要真正打开看。产物让砚挂在当前回复上展示，不要只把路径发给用户。',
  '',
  '能力选择顺序：本机已有工具 / 脚本 → 合适的 Skill → 发布方 CLI / API → 确实需要的 MCP；用户明确指定时按用户说的来。'
].join('\n')

/**
 * 结构化回答块的常驻说明（格式见 src/shared/visual-blocks.ts，完整写法在随包 visual-answer 技能）。
 *
 * 常驻部分只说「什么时候用、有哪些块」；字段格式在技能里，模型要写块时再读。
 *
 * 单独成段：除了拼进系统提示，还写进 pi 的具名分区 systemPromptOptions.sections ——
 * 只转发结构化部分的 provider（pi-claude-bridge 转给 Claude Code）会丢掉整段覆盖的文本，但会转发分区。
 */
export const VISUAL_ANSWER_GUIDE = [
  '回答呈现：默认用简短自然的文字，先给结论；不要为了好看加块、加标题或拆成长清单。只有用户明确要图表、对比或可视化，或确有 4 个以上需要横向比较的数据时，才用砚的图形块：yan-chart（数值比较或趋势，必须写数据出处）、yan-stats（几个关键数字）、yan-cards（推荐或对比 2–8 个选项）、yan-record（一个对象的详情）、yan-flow（多个因素导致一个结果）、yan-steps（分阶段过程）、mermaid（流程 / 时序 / 关系图）、yan-widget（机制示意或可调参数的讲解）。',
  '写 yan-* 块前先读技能 visual-answer 取字段格式。数字只用资料或用户给的，不编造；一次回答最多一两个块。'
].join('\n')
const VISUAL_SECTION = 'inkstone_visual_answer'

/** 可视化回答开关（desktop.json 的 visualAnswers，缺省开）：每轮读，关掉后下一轮起不再说明这些写法 */
export function visualAnswersEnabled() {
  try {
    const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
    return JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8'))?.visualAnswers !== false
  } catch {
    return true
  }
}

/**
 * 幂等标记：判断这段是否已经注入过。
 *
 * 不能只判断「系统提示里有没有 yan」—— 用户的 AGENTS.md 里也可能写了 yan。
 * 用一句只可能来自本扩展的完整短语。
 */
const MARKER = '砚提供了一组本机能力，通过 `yan` 命令使用'

export default function capabilityGuideExtension(pi) {
  pi.on('before_agent_start', (event) => {
    const base = String(event?.systemPrompt ?? '')
    if (base.includes(MARKER)) return
    /* 先读 base 再写分区：覆盖用的整段文本里不会重复出现这一段 */
    const visual = visualAnswersEnabled()
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      sections.inkstone_capabilities = CAPABILITY_GUIDE
      if (visual) sections[VISUAL_SECTION] = VISUAL_ANSWER_GUIDE
    }
    const guide = visual ? `${CAPABILITY_GUIDE}\n\n${VISUAL_ANSWER_GUIDE}` : CAPABILITY_GUIDE
    return { systemPrompt: base ? `${base}\n\n${guide}` : guide }
  })
}
