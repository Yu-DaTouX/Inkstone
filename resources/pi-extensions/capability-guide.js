import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CAPABILITY_GUIDE = [
  '砚提供了一组本机能力，通过 `yan` 命令使用（已在 PATH 中，无需安装）。你运行在 Inkstone（砚）桌面应用内，pi 是执行内核；系统命令用 bash 工具（Windows 上没有 Git Bash 时是 PowerShell 工具）；bash 工具里写 bash 语法，不要混入 Get-Content 之类的 PowerShell 命令。工具里执行成功不等于已在用户界面的交互终端里执行。',
  '',
  '调用原则：',
  '- 用户要求执行时，在授权范围内用已有能力做完，不停在「可以帮你」或让用户代做；只讨论方案或询问用法时直接回答，不为展示而调用。',
  '- 用户指定了工具或方法就照做；涉及砚的页面、产物或持久状态时用对应 `yan` 入口，不自写脚本绕过。',
  '- 能力不可用、需要审批或用户接管时如实说明，不绕过限制，不猜用户答案。',
  '',
  '能力目录（用某组前先读 `yan <组> --help`；标了技能的，先用 read 打开技能清单里对应的 SKILL.md；已经读过就不必重读）：',
  '- capabilities：不确定有没有某种能力时检索；缺技能时读技能 capabilities，自己找合适的技能并申请接入（用户在批准面板决定）',
  '- browser：打开、操作或检查网页（填表、复现网页问题、需要登录的页面）',
  '- search：联网找资料、读网页正文、查开发库文档',
  '- question：信息不足、需要用户做决定时提问',
  '- tasks：任务清单，显示在用户右栏的「待办」；3 步以上、派了子代理或用户要计划时，开工前先建，完成一项或计划变化时更新；单步小事不建',
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

export const VISUAL_ANSWER_GUIDE = [
  '回答呈现：默认用简短自然的文字，先给结论；不要为了好看加块、加标题或拆成长清单。只有用户明确要图表、对比或可视化，或确有 4 个以上需要横向比较的数据时，才用砚的图形块：yan-chart（数值比较或趋势，必须写数据出处）、yan-stats（几个关键数字）、yan-cards（推荐或对比 2–8 个选项）、yan-record（一个对象的详情）、yan-flow（多个因素导致一个结果）、yan-steps（分阶段过程）、mermaid（流程 / 时序 / 关系图）、yan-widget（机制示意或可调参数的讲解）。',
  '写 yan-* 块前先读技能 visual-answer 取字段格式。数字只用资料或用户给的，不编造；一次回答最多一两个块。'
].join('\n')
const VISUAL_SECTION = 'inkstone_visual_answer'

export function visualAnswersEnabled() {
  try {
    const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
    return JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8'))?.visualAnswers !== false
  } catch {
    return true
  }
}

export function sessionSkillsBlock(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(sessionId) || sessionId === '.' || sessionId === '..') return ''
  const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  const base = join(dir, 'capabilities', 'session-skills', sessionId)
  let skills
  try {
    const index = JSON.parse(readFileSync(join(base, 'index.json'), 'utf8'))
    skills = index?.version === 1 && index.sessionId === sessionId && Array.isArray(index.skills) ? index.skills : []
  } catch {
    return ''
  }
  const lines = skills
    .filter((skill) => typeof skill?.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name))
    .map((skill) => {
      const path = join(base, skill.name, 'SKILL.md')
      const description = String(skill.description ?? '').replace(/\s+/g, ' ').slice(0, 300)
      return existsSync(path) ? `- ${skill.name}：${description} → ${path}` : ''
    })
    .filter(Boolean)
  if (lines.length === 0) return ''
  return ['本次会话接入的技能（只对这个会话生效；用法同其他技能：先 read 对应 SKILL.md，相对路径以它所在目录为基准）：', ...lines].join('\n')
}
const SESSION_SKILLS_SECTION = 'inkstone_session_skills'

const MARKER = '砚提供了一组本机能力，通过 `yan` 命令使用'

export default function capabilityGuideExtension(pi) {
  pi.on('before_agent_start', (event, ctx) => {
    const base = String(event?.systemPrompt ?? '')
    if (base.includes(MARKER)) return
    const visual = visualAnswersEnabled()
    let sessionSkills = ''
    try {
      sessionSkills = sessionSkillsBlock(ctx?.sessionManager?.getSessionId?.())
    } catch {
    }
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      sections.inkstone_capabilities = CAPABILITY_GUIDE
      if (visual) sections[VISUAL_SECTION] = VISUAL_ANSWER_GUIDE
      if (sessionSkills) sections[SESSION_SKILLS_SECTION] = sessionSkills
    }
    const guide = [CAPABILITY_GUIDE, visual ? VISUAL_ANSWER_GUIDE : '', sessionSkills].filter(Boolean).join('\n\n')
    return { systemPrompt: base ? `${base}\n\n${guide}` : guide }
  })
}
