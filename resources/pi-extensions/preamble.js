/*
 * 砚「系统提示开场白」薄层：把 pi 内置 preamble 里的产品名换成砚（Yan）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════
 *   pi 的 preamble 是**编译进运行时**的英文句子（`buildSystemPromptSections`：
 *   "You are an expert coding assistant operating inside pi, …"）。砚既没有传
 *   `--system-prompt`（那是**整段替换**：tools / rules / docs / project_context
 *   都得自己重写维护，pi 升级后必然漂移），也没有传 `customPrompt`，所以只能
 *   在 `before_agent_start` 里对**这一句**做定点替换。
 *
 *   措辞保持英文（与 pi 原生一致），只把产品名从 `pi` 换成 `Yan` —— 用户
 *   明确要求开场白用英文；换成中文会让整份系统提示在开头突然变语言。
 *
 * ── 边界（别扩写）──
 *   · 只替换 preamble 这一句；tools / rules / docs / project_context 原样不动；
 *   · 认不出原生句子时**原样放行**（pi 改了措辞就失效，而不是去改别的地方）；
 *   · 幂等：替换后不再包含原句，同一份提示里不会重复替换；
 *   · 与界面语言**无关** —— 界面语言由 language.js 负责，这里不做语言判断，
 *     界面语言读不出来时这句开场白也照样生效。
 */

/** pi 内置 preamble（0.87.1 起，逐字取自 bundle 的 buildSystemPromptSections）。 */
export const NATIVE_PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'

/** 砚的 preamble：与原生句同措辞，只把产品名 `pi` 换成 `Yan`。 */
export const YAN_PREAMBLE =
  'You are an expert coding assistant operating inside Yan, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'

export default function preambleExtension(pi) {
  pi.on('before_agent_start', (event) => {
    const base = String(event?.systemPrompt ?? '')
    if (!base.includes(NATIVE_PREAMBLE)) return
    return { systemPrompt: base.replace(NATIVE_PREAMBLE, YAN_PREAMBLE) }
  })
}
