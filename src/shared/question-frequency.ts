/**
 * 歧义澄清提问频率（全局偏好）。
 *
 * 三档只**调节模型每轮收到的提问指引**，不是精确次数保证：
 *   · `sparse`   少问：能合理推断就继续，只在关键决定 / 风险前确认；
 *   · `balanced` 适中（默认）：理解差异明显影响结果时才问，可查证的不问；
 *   · `eager`    多问：多种合理理解时用短问确认目标再执行（不每几步硬问）。
 *
 * 无论哪一档都不改变权限审批与高风险确认，也不覆盖工作模式：
 * 自主模式仍不问、计划模式仍先问关键问题、用户明确的「先问 / 别问」优先。
 * 偏好按下一轮生效，不修改历史与当前正在跑的那一轮。
 *
 * 主进程与渲染端共用这里的类型与归一化；内置扩展
 * `resources/pi-extensions/question.js` 在无构建环境里运行，另有一份等价实现，
 * 由 `scripts/test-question-frequency.mjs` 对照，避免两处漂移
 * （与 `shared/context-limits.ts` 的做法相同）。
 */

export type QuestionFrequency = 'sparse' | 'balanced' | 'eager'

/** 三档的顺序就是设置界面里的分段顺序。 */
export const QUESTION_FREQUENCIES: readonly QuestionFrequency[] = ['sparse', 'balanced', 'eager']

export const DEFAULT_QUESTION_FREQUENCY: QuestionFrequency = 'balanced'

/** 非法 / 缺失值安全归一到默认档（绝不因脏值改变行为）。 */
export function normalizeQuestionFrequency(value: unknown): QuestionFrequency {
  return QUESTION_FREQUENCIES.includes(value as QuestionFrequency)
    ? (value as QuestionFrequency)
    : DEFAULT_QUESTION_FREQUENCY
}

/*
 * ── 会话级覆盖（四态）──
 *
 * 会话可以比全局更具体：`inherit` 表示「跟随全局」，其余三档是**显式**选择。
 * 显式值不被后来的全局变更覆盖；`inherit` 每轮都要重新读全局（所以全局改档
 * 对继承会话下一轮就生效）。四态与工作模式共用同一条会话记录，但不混进
 * `WorkMode` 枚举：一个管「做事的节奏」，一个只调「何时问」。
 */

/** 会话级四态：inherit（继承全局）+ 三档显式值。顺序就是界面分段顺序。 */
export const SESSION_QUESTION_FREQUENCIES = ['inherit', ...QUESTION_FREQUENCIES] as const

export type SessionQuestionFrequency = (typeof SESSION_QUESTION_FREQUENCIES)[number]

/** 新会话不带覆盖：跟随全局。显式值才落盘，保持「默认态不写盘」的约定。 */
export const DEFAULT_SESSION_QUESTION_FREQUENCY: SessionQuestionFrequency = 'inherit'

/** 非法 / 缺失值安全归一到继承（旧会话记录没有这个字段时也走这里）。 */
export function normalizeSessionQuestionFrequency(value: unknown): SessionQuestionFrequency {
  return SESSION_QUESTION_FREQUENCIES.includes(value as SessionQuestionFrequency)
    ? (value as SessionQuestionFrequency)
    : DEFAULT_SESSION_QUESTION_FREQUENCY
}

/** 这个值是不是「显式覆盖」（用于判断快照里要不要清掉旧档）。 */
export function isExplicitSessionQuestionFrequency(value: unknown): value is QuestionFrequency {
  return QUESTION_FREQUENCIES.includes(value as QuestionFrequency)
}

/**
 * 会话偏好 + 全局偏好 → 本轮**实际**档位。
 *
 * `inherit`（含缺失 / 非法）回落全局；显式值原样返回，不被全局覆盖。
 * 扩展侧有一份等价实现（`resources/pi-extensions/question.js`），由测试对照。
 */
export function resolveQuestionFrequency(sessionValue: unknown, globalValue: unknown): QuestionFrequency {
  const preference = normalizeSessionQuestionFrequency(sessionValue)
  return preference === 'inherit' ? normalizeQuestionFrequency(globalValue) : preference
}
