/**
 * N21-9 合成任务集（实施-06 S2）。
 *
 * ════════════════════════════════════════════════════════════
 * 任务集要「压」出什么
 * ════════════════════════════════════════════════════════════
 * 基准要测的是**约束在压缩之后还在不在**。所以每个任务的形状是固定的：
 *
 *   ① 开头把一组**具体、可机械核对**的约束交代清楚（魔数、格式、单位、标记）；
 *   ② 中间灌大量与约束无关的噪音（大段工具输出）—— 把上下文推过工作集线，逼出压缩；
 *   ③ 最后要求产出一份**交付物**；
 *   ④ 判分只回答一件事：交付物里那几条约束**还在不在**。
 *
 * ════════════════════════════════════════════════════════════
 * 2026-09-19 两次重做：为「让基线（A 组）真的会丢约束」
 * ════════════════════════════════════════════════════════════
 * 第一版（v1–v6，见 `docs/plan/证据-06-S2-N21-9基准-2026-09-19.md`）的教训是
 * **A 组丢失率只有 0–3%** —— 没有丢失就没有对比空间，四组差异完全被噪声主导。
 *
 * **重做之一（编排）**：约束只在最开头出现一次，末尾交付**不点名**它们
 *（见 `scripts/bench/context-bench.mjs` 的 `buildPrompt`）。
 *
 * **重做之二（约束本身，本轮）**：第一次校准（A 组 ×4，12 次）拓到只有 **10%** 丢失，
 * 而且集中在三条上：
 *
 *   | 约束 | 丢/次 | 为什么 |
 *   |---|---|---|
 *   | `batch-3`（一次最多 3 条） | 3/4 | **不提醒就不会写**的约定 |
 *   | `iso-date`（YYYY-MM-DD） | 2/4 | 同上（写日期时不会主动用格式） |
 *   | `timeout-30`（30s） | 1/4 | 同上（具体数值） |
 *   | 其余 12 条 | 0/12 | **模型本来就会写**：魔数、安全开关、缩进…… |
 *
 * 结论很清楚：**只把「模型本来就会做的事」写成约束，是测不出丢失的**。
 * 所以本轮把每条约束都换成**被动型**——只有被专门提醒过、且真的记住了，交付物里
 * 才会出现（优先级标记 `[P0]`、负责人字段 `owner:`、条数小结、具体数值、唯一码）。
 *
 * ⚠️ 判分仍然只认**正向**标志（`must-include` / `must-match`）：v1/v5 两次假阳性证明，
 * 自然语言交付物上的「禁止类」约束用字符串规则判一定会误伤（模型写「不要用 X」）。
 *
 * ⚠️ 每条约束都自带 `kept` / `violated` 两个**最小样例**，单测会拿它们去跑
 * 判分规则（`scripts/test-context-bench.mjs`）—— 写错的约束（例如正则永远匹配不上）
 * 必须在跑批之前就暴露，否则一次真实跑批的结论会整体作废。
 */

/**
 * 一个任务。
 *
 * `filler` 是**要模型真去执行**的噪音指令（不是本地注入的字符串）——
 * 必须是真跑出来的大输出，否则「上下文被压过」这件事不会发生。
 */
export const BENCH_TASKS = [
  {
    id: 'magic-style',
    title: '上线清单的格式约定（被动型）',
    /** 开头交代的约束（逐条可判） */
    constraints: [
      {
        id: 'magic',
        text: '配置校验码用 7f3a91（就这么一个）',
        check: { kind: 'must-include', needle: '7f3a91' },
        kept: '校验码 7f3a91。',
        violated: '校验码是刚才那台机器给的。'
      },
      {
        /* 被动型：不专门提醒，清单里不会出现优先级标记 */
        id: 'priority-tag',
        text: '每条前面标优先级，写成 [P0] 或 [P1]',
        check: { kind: 'must-match', pattern: '\\[P[01]\\]' },
        kept: '[P0] 先备份。',
        violated: '先备份（这条比较急）。'
      },
      {
        id: 'owner-field',
        text: '每条都要带负责人，写成 owner: 后面跟名字',
        check: { kind: 'must-include', needle: 'owner:' },
        kept: '- 先备份 owner: 老王',
        violated: '- 先备份（老王负责）'
      },
      {
        /* 具体数值（不是单位）：模型写「毫秒」很容易，写「恰好 500」要记得住 */
        id: 'value-500ms',
        text: '健康检查的超时按 500ms 算',
        check: { kind: 'must-match', pattern: '500\\s?ms' },
        kept: '健康检查超时设成 500ms。',
        violated: '健康检查超时设短一点。'
      },
      {
        id: 'tag-shape',
        text: '版本标签一律写成 v1.2.3 这种三段的',
        check: { kind: 'must-match', pattern: 'v\\d+\\.\\d+\\.\\d+' },
        kept: '标签打 v1.2.3。',
        violated: '标签打 v1.2 就行。'
      },
      {
        /* 收尾统计：只有记住了要求才会写 */
        id: 'count-line',
        text: '最后加一行「共 N 条」',
        check: { kind: 'must-match', pattern: '共\\s?\\d+\\s?条' },
        kept: '共 12 条。',
        violated: '就这些。'
      }
    ],
    /** 灌噪音：真跑、真产生大输出 */
    /*
     * 12 条、每条 5–10k token，合起来 75–100k —— 远超工作集（live 压到 6000），
     * 压缩会真的发生好几次，开头的「背景」早就不在最近窗口里。
     */
    filler: [
      'seq 1 3000',
      'node -e "console.log(JSON.stringify({a:1,b:2},null,2).repeat(600))"',
      'seq 3001 6000',
      'node -e "console.log(\'y\'.repeat(9000))"',
      'seq 6001 9000',
      'node -e "console.log(JSON.stringify([1,2,3]).repeat(1200))"',
      'seq 9001 12000',
      'node -e "console.log(JSON.stringify({k:\'v\',n:42}).repeat(900))"',
      'seq 12001 15000',
      'node -e "console.log(\'t\'.repeat(9000))"',
      'seq 15001 18000',
      'node -e "console.log(JSON.stringify([5,6,7]).repeat(1200))"'
    ],
    /** 最后的交付要求：只说产物，不点名上面那几条约定 */
    deliverable: '给出一份《上线检查清单》，按执行顺序排。'
  },
  {
    id: 'naming-format',
    title: '命名与格式约定（被动型）',
    constraints: [
      {
        id: 'snake',
        /* 原来「不许 camelCase」会在模型写「不要用 maxRetryCount」时误判 → 正向 */
        text: '配置项名字写 snake_case（比如 max_retry_count）',
        check: { kind: 'must-match', pattern: '[a-z][a-z0-9]*_[a-z0-9_]+' },
        kept: '用 max_retry_count 这个名字。',
        violated: '用 retryCount 这个名字。'
      },
      {
        id: 'iso-date',
        text: '日期一律 YYYY-MM-DD',
        check: { kind: 'must-match', pattern: '\\d{4}-\\d{2}-\\d{2}' },
        kept: '截止日 2026-09-19。',
        violated: '截止日是下周五。'
      },
      {
        id: 'no-console',
        /* 正向：要求给出正规日志入口，而不是「不许提 console.log」 */
        text: '输出走 logger.info，别用裸打印',
        check: { kind: 'must-match', pattern: 'logger\\.info', flags: 'i' },
        kept: '用 logger.info 输出。',
        violated: '随便打印一下就行。'
      },
      {
        /* 第一次校准里这条丢了 3/4 —— 留着，它是「被动型」的代表 */
        id: 'batch-3',
        text: '一次最多处理 3 条（批大容易把上游打挂）',
        check: { kind: 'must-match', pattern: '(最多|不超过|上限)\\s?3\\s?(条|个)' },
        kept: '一次最多 3 条。',
        violated: '一次跑完所有条目。'
      },
      {
        id: 'trailing',
        /* `must-include '末尾换行'` 太依赖措辞（模型写「保留换行符」就漏）→ 放宽到「换行」 */
        text: '文件末尾那个换行别丢',
        check: { kind: 'must-include', needle: '换行' },
        kept: '注意保留文件末尾换行。',
        violated: '格式没问题。'
      },
      {
        id: 'count-line',
        text: '最后加一行「共 N 条」',
        check: { kind: 'must-match', pattern: '共\\s?\\d+\\s?条' },
        kept: '共 12 条。',
        violated: '就这些。'
      }
    ],
    filler: [
      'seq 1 3000',
      'node -e "console.log((\'x\'.repeat(7000)))"',
      'seq 3001 6000',
      'node -e "console.log(\'y\'.repeat(9000))"',
      'seq 6001 9000',
      'node -e "console.log(\'z\'.repeat(9000))"',
      'seq 9001 12000',
      'node -e "console.log((\'w\'.repeat(8000)))"',
      'seq 12001 15000',
      'node -e "console.log(\'p\'.repeat(9000))"',
      'seq 15001 18000',
      'node -e "console.log((\'v\'.repeat(9000)))"'
    ],
    deliverable: '给出一份《命名与格式检查清单》。'
  },
  {
    id: 'scope-list',
    title: '范围与执行顺序约定（被动型）',
    constraints: [
      {
        id: 'only-main',
        text: '只动 src/main 下的东西，别扩到别处',
        check: { kind: 'must-match', pattern: 'src[/\\\\]main' },
        kept: '只改 src/main/index.ts。',
        violated: '顺手也改了渲染层。'
      },
      {
        id: 'three-steps',
        text: '步骤编号写成 1. 2. 3. 这种',
        check: { kind: 'must-match', pattern: '^1\\. [\\s\\S]*^2\\. [\\s\\S]*^3\\.', flags: 'm' },
        kept: '1. 先读\n2. 再改\n3. 最后验',
        violated: '先读、再改、最后验。'
      },
      {
        id: 'risk',
        text: '清单里要有「风险」这一节',
        check: { kind: 'must-include', needle: '风险' },
        kept: '风险：这一步不可逆。',
        violated: '没有别的要注意的。'
      },
      {
        id: 'no-force',
        /* 正向：要求给出安全推送姿势 */
        text: '强推用 --force-with-lease，别用裸 --force',
        check: { kind: 'must-include', needle: '--force-with-lease' },
        kept: '用 git push --force-with-lease 覆盖远端。',
        violated: '直接 push 就行。'
      },
      {
        /* 第一次校准里丢了 1/4 —— 具体数值，留着 */
        id: 'timeout-30',
        text: '命令超时按 30s 算，超过就断',
        check: { kind: 'must-match', pattern: '30\\s?s\\b' },
        kept: '超时 30s 就断。',
        violated: '让它一直跑着。'
      },
      {
        id: 'count-line',
        text: '最后加一行「共 N 条」',
        check: { kind: 'must-match', pattern: '共\\s?\\d+\\s?条' },
        kept: '共 12 条。',
        violated: '就这些。'
      }
    ],
    filler: [
      'seq 1 3000',
      'node -e "console.log(JSON.stringify({k:\'v\'}).repeat(500))"',
      'seq 3001 6000',
      'node -e "console.log(\'q\'.repeat(9000))"',
      'seq 6001 9000',
      'node -e "console.log(JSON.stringify([9,8,7]).repeat(1200))"',
      'seq 9001 12000',
      'node -e "console.log(\'r\'.repeat(9000))"',
      'seq 12001 15000',
      'node -e "console.log(JSON.stringify([1,1,1]).repeat(1200))"',
      'seq 15001 18000',
      'node -e "console.log(\'s\'.repeat(9000))"'
    ],
    deliverable: '给出《改动范围与执行顺序》。'
  }
]

/** 跑批规模（四策略 × 任务数）—— 报告里要写清「跑了多少」，不是「跑了一轮」 */
export function benchPlanSize(strategyCount = 4) {
  return {
    tasks: BENCH_TASKS.length,
    strategies: strategyCount,
    runs: BENCH_TASKS.length * strategyCount
  }
}
