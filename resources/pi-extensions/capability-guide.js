/*
 * 砚内置「能力入口说明」扩展。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它解决什么问题
 * ══════════════════════════════════════════════════════════════════
 * 架构修订（docs/archive/2026-09-18-架构修订-默认pi与砚原生能力层.md）定的路线是：
 * 砚的能力**不注册成模型工具**，而是通过随包 CLI `yan` 触达。
 * 那么模型必须知道两件事，否则它根本不会去用：
 *   ① 有这么个入口、怎么查、输出长什么样；
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
 *   · 只说**怎么用**，不描述能力细节（细节用 `yan --help` 按需读，避免长期占上下文）；
 *   · 不在这里写产品规则、语气要求、语言要求（那些各有归属）；
 *   · 命令清单要与 resources/yan-cli/yan.mjs 的用法保持一致。
 */

/**
 * 能力入口说明。
 *
 * 写法上刻意区分了「查什么」与「怎么读结果」：
 * 前者决定模型会不会去用，后者决定它用完之后会不会把上下文撑爆。
 */
export const CAPABILITY_GUIDE = [
  '砚提供了一组本机能力，通过 `yan` 命令使用（已在 PATH 中，无需安装）：',
  '',
  '- 不确定有没有对应能力：`yan capabilities search --query-file query.json`',
  '- 查看一次操作的结果：`yan operations status --id <操作ID>`',
  '- 读写任务清单：`yan tasks apply --request-file task-update.json`',
  '- 信息不足且需要用户决定时：先写 `question.json`，再调用 `yan question ask --request-file question.json`；完整回答在 `resultFile`，取消 / 超时会如实返回，不要猜答案。',
  '- 需要读回墓碑上的 `ctx://` 归档：`yan context recall --ref <ctx://...>`；stdout 的 `resultFile` 是受管原始文本，用 read 按需取需要的片段。它以 `[Recalled context]` 开头，并会在下一次用户输入时过期为存根。',
  '- 生成图片文件：先写 `image.json`，再调用 `yan image generate --request-file image.json`；生成结果会自动挂到当前助手消息并在对话中直接预览。',
  '- 展示已有文件：`yan artifact attach --path <项目内文件> --description "说明"`；结果会复制到砚的受控目录并挂到当前助手消息。',
  '- 图片生图默认优先使用当前 ChatGPT/Codex 订阅通道；如果选择 `openai` 或 `compatible` API，砚会先弹出确认，未确认不会发出请求。',
  '- 委派一个独立子代理：`yan subagent start --task "..."`（默认独立 Git worktree）',
  '- 查看子代理进度：`yan subagent list`；看单个转录：`yan subagent get --id <子代理ID>`',
  '- 停止子代理：`yan subagent stop --id <子代理ID>`',
  '- 看全部命令：`yan --help`（按需读，不要在每轮都读）',
  '',
  '输出约定：stdout 只有一段**摘要**（类型 / 条数 / 操作 ID + 结果文件路径）；',
  '完整结果在 `resultFile` 指向的文件里，用文件读取工具**只取需要的片段**，',
  '不要把整个结果文件原样读进上下文。',
  '',
  '文件产物约定：生成或挂载后，stdout 的摘要会带 artifact id、文件名、类型和受控路径；不要只把路径文字发给用户，直接让砚的当前助手消息展示产物。',
  '',
  '子代理调用约定：',
  '  · 任务较短可直接用 `yan subagent start --task "任务"`；复杂任务先写 JSON 请求文件，字段为 `task`、可选 `model`、可选 `readOnly: true`，再用 `--request-file`。',
  '  · 默认 worktree 会把代码改动隔离出来；只有需要在当前目录做只读检查时才用 `readOnly: true`。',
  '  · start 的摘要会返回子代理 ID；需要轮询时调用 list/get。启动后砚会把同一个任务实时显示在输入区上方和右侧详情面板，用户能看到状态、当前活动、工具调用、转录、耗时和变更。',
  '  · 不要假设子代理已经完成或自动合并：完成后把结果交给用户审阅；worktree 的合并/放弃由用户在 UI 里确认。',
  '',
  '能力选择顺序：本机已有工具 / 脚本 → 合适的 Skill → 发布方 CLI / API → 确实需要的 MCP。',
  '用户明确指定用某个能力时，按用户说的来。'
].join('\n')

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
    return { systemPrompt: base ? `${base}\n\n${CAPABILITY_GUIDE}` : CAPABILITY_GUIDE }
  })
}
