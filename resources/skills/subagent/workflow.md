# 工作流：用脚本编排子 Agent

工作流是一段 JavaScript 编排脚本：你写好脚本，用 `yan workflow run --file <脚本.js>` 交给宿主在后台运行。脚本里每个 `agent()` 是一个子 Agent（和 `yan subagent start` 派出的一样：独立进程、可换模型、可只读或进 worktree）。中间结果留在脚本变量里，运行结束时宿主只把脚本 `return` 的值作为一条通知发给你，你的上下文不会被几十份报告刷满。

适合：一个清单逐项处理（几十个文件逐个审计、批量迁移）、要对抗复核的结论、要多轮查找直到没有新发现的问题、要从几个角度出方案再比较的难题。一两个子任务直接用 `yan subagent start`；闲聊和小改动自己做。

## 怎么跑

1. 先自己侦察：列出文件、调用点、改动清单，让脚本基于一份具体的清单工作。
2. 把脚本写到文件里（项目里的 `.tmp/` 或任意可读位置），然后：`yan workflow run --file .tmp/audit.js [--args '{"dir":"src/routes"}']`。
3. 启动后立刻返回运行 ID。不要 sleep 轮询；结束时宿主会发来「工作流已完成」或「工作流失败」通知。其间可以做不依赖它的事，或者结束本轮告诉用户工作流在跑。
4. 用户在消息流的运行卡上能看到阶段进度、展开看每个子 Agent，也能暂停或停止。
5. 查进度：`yan workflow get --id <ID>`；暂停：`pause`；停止：`stop`；续跑：`resume`（见下文）。

## 脚本长什么样

```js
export const meta = {
  name: 'audit-routes',
  description: '逐个审计路由处理函数的鉴权，并对抗复核每条发现',
  phases: ['侦察', '审计', '复核']
}

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: { type: 'array', items: { type: 'object', required: ['text', 'where'], properties: { text: { type: 'string' }, where: { type: 'string' } } } }
  }
}
const VERDICT = { type: 'object', required: ['refuted', 'why'], properties: { refuted: { type: 'boolean' }, why: { type: 'string' } } }

phase('侦察')
const found = await agent('列出 src/routes/ 下所有 .ts 文件', {
  label: '列路由文件',
  readOnly: true,
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } }
})

phase('审计')
const audits = await pipeline(found.files, (file) =>
  agent(`审计 ${file} 是否缺少鉴权检查，每条发现给出 文件:行 证据`, { label: file, readOnly: true, schema: FINDINGS })
)

phase('复核')
const claims = audits.filter(Boolean).flatMap((a) => a.findings)
const verdicts = await pipeline(claims, (c) =>
  parallel([1, 2, 3].map((i) =>
    agent(`设法证明这条结论是错的：${c.text}（${c.where}）。拿不准按「驳倒」处理。`, { label: `复核 ${c.where} #${i}`, readOnly: true, schema: VERDICT })
  ))
)
log(`${claims.length} 条发现已复核`)
return claims.filter((c, i) => (verdicts[i] ?? []).filter((v) => v && v.refuted === false).length >= 2)
```

- **首条语句**必须是 `export const meta = {…}`，只能写纯字面量（字符串、数字、布尔、数组、对象；不能用变量、函数调用、展开、带 `${}` 的模板字符串）。`name` 和 `description` 必填；`phases` 可选，每项要和 `phase()` 传的标题一字不差，没列出的 `phase()` 标题会单独成组。
- 脚本体是普通 JavaScript，可以直接用顶层 `await` 和 `return`。`return` 的值（要能转成 JSON）就是最终答案。
- 运行前先校验 meta 和语法，有错直接报出来、不启动。

## 可用的全局

| 名称 | 作用 |
| --- | --- |
| `agent(prompt, opts)` | 派一个子 Agent，返回它的最终报告（字符串）；带 `schema` 时返回校验过的 JSON。被停止时返回 `null`；失败时抛错 |
| `parallel(tasks)` | 同时跑一组（元素是 `agent()` 返回的 Promise，或返回 Promise 的函数），等全部结束；失败或被停的位置是 `null` |
| `pipeline(items, fn)` | 每个元素跑一次 `fn(item, index)`，结果按原顺序排列；失败或被停的位置是 `null` |
| `phase(title)` | 之后派的子 Agent 归到这个阶段（运行卡上的阶段条） |
| `log(text)` | 在运行卡上显示一句进度说明 |
| `args` | `--args` 传入的 JSON；没传时是 `undefined` |

`agent()` 的选项：

| 选项 | 说明 |
| --- | --- |
| `label` | 界面上显示的短标题（对应 `yan subagent start --title`） |
| `model` / `thinking` | 换模型、换思考档位；写法同 `yan subagent start` |
| `readOnly: true` | 只读子 Agent（只看不改） |
| `isolation: 'worktree'` | 在独立 worktree 里改代码（要求 Git）。并行的写入任务不写这个时，同目录已有写入型子 Agent 在跑也会自动进 worktree |
| `timeoutMinutes` | 1–60，到点只提醒、不停止 |
| `goal` / `deliverables` / `sources` / `boundary` | 任务输入，同 `yan subagent start` 的 brief |
| `schema` | 要它交回的 JSON 结构（见下） |

直接 `await agent(...)` 的调用失败会抛错，不捕获时整个运行以失败结束；放进 `parallel()` / `pipeline()` 里的失败变成 `null`，所以结果要先 `.filter(Boolean)` 再用。

## 结构化输出（schema）

带 `schema` 时，宿主在任务末尾要求子 Agent 最后只交一个 ```json 代码块，并按 schema 校验；不合格就续接同一个子 Agent 说明哪里不对（它记得上下文），最多续接 3 次，仍不合格时这次调用失败。

schema 只支持 `type`（object / array / string / number / integer / boolean / null，可写数组）、`required`、`properties`、`items`、`enum`、`additionalProperties`；`description`、`title` 这类说明可以写。用了别的关键字（`minItems`、`pattern`、`oneOf` 等）或自相矛盾（比如 `required` 里的字段被 `additionalProperties: false` 排除），运行直接报错、子 Agent 不会启动。

## 限制

- 脚本不能读写文件、跑命令、联网，也不能 `import` / `import()`；这些交给子 Agent，脚本只做编排。
- `Date.now()`、`Math.random()`、无参数的 `new Date()`（以及 `Date()`）会让运行失败：续跑时要按同样的顺序重放 `agent()` 调用。需要时间戳或随机种子就从 `args` 传进来。
- `agent()` 的参数不合法（未知选项、类型不对、schema 不支持）也会让整个运行失败，不会悄悄变成 `null`。
- 单次运行最多 200 个 `agent()` 调用；单次 `parallel()` / `pipeline()` 最多 1000 项。超了直接报错，不会悄悄截断；更大的活拆成几次运行。
- 单次运行默认同时跑 8 个子 Agent（`--concurrency` 最多 24），和全应用其他子 Agent 共用 24 个名额，满了自动排队。
- 运行中不能向用户提问。需要用户中途拍板时，拆成几个工作流分别跑，中间停下来问。
- 子 Agent 的每次工具调用照常过权限检查。
- 脚本里不合并 worktree：运行结束的通知会列出有改动的 worktree 子 Agent，由你看过补丁后 `yan subagent merge --id <ID>` 或 `discard`。
- `agent()` 没有 `stallMs`；子 Agent 照常是连续 10 分钟没有输出就收尾、等额度时排队。

## 续跑

运行记录在 `<数据目录>/workflows/runs/<会话ID>/<运行ID>/`：`script.js`、`journal.jsonl`（每次 `agent()` 的序号、提示词哈希、子 Agent ID、状态、结果）、`result.json`。

`yan workflow resume --id <ID> [--file <改过的脚本>] [--args <JSON>]` 按调用顺序重放：

- 序号和提示词（连同 schema、模型、只读等选项）都没变、上次已完成的调用，直接返回保存的结果，不再派子 Agent。
- 遇到第一个变了、上次失败、或停止时还在跑的调用，从它开始往后**全部**重跑，包括后面上次已完成的。比如依次派了 A、B、C、D，B 失败：续跑时 A 直接返回，B、C、D 重跑。把脚本改成先派 C 再派 B：A 直接返回，C、B、D 重跑。
- 暂停的运行 `resume` 只是继续派；应用重启后运行停在原地（状态 interrupted），不会自动续跑。
- 上一次的子 Agent 还没退出时不能续跑，等它们结束。

所以：会变的东西（时间、随机数）从 `args` 传；同一个 `pipeline` 项里串联多个 `agent()` 时，后面那步的派出顺序取决于前面谁先完成，续跑时可能多重跑几个。

## 常用模式

**一项一代理**：先用一个代理（或你自己侦察）拿到清单，再 `pipeline(list, item => agent(…))`，每项任务要窄，结论带 `文件:行`。

**对抗复核投票**：每条重要结论派三名只读复核者，任务写成「设法证明它是错的」，各给一个不同角度（正确性、边界与异常、安全、能否复现），能换模型就换（`model`）。拿不准一律按「被驳倒」处理，多数没驳倒才保留：

```js
const votes = await parallel(['正确性', '边界与异常', '能否复现'].map((angle) =>
  agent(`从「${angle}」角度设法证明这条结论是错的：${claim}`, { readOnly: true, schema: VERDICT })))
const kept = votes.filter((v) => v && v.refuted === false).length >= 2
```

**找到连续两轮没有新发现为止**：判断「新」要对比之前见过的全部发现，包括已经被否掉的，否则被否掉的会反复冒出来：

```js
const seen = new Set()
let quiet = 0
for (let round = 1; quiet < 2 && round <= 8; round += 1) {
  phase(`第 ${round} 轮`)
  const found = await agent(`找出 ${args.target} 里还没列出的问题。已知（含已否掉的）：${[...seen].join('；') || '无'}`, { readOnly: true, schema: LIST })
  const fresh = (found?.items ?? []).filter((item) => !seen.has(item))
  fresh.forEach((item) => seen.add(item))
  quiet = fresh.length ? 0 : quiet + 1
}
return [...seen]
```

**多角度出方案再比较**：派两三个代理从不同出发点各出一版（最小改动、风险优先、用户体验优先），再派一个只读代理比较、以最好的一版为主吸收其他版本的长处。

**改到检查通过为止**：一个代理跑检查、交回失败清单（schema），按文件拆给写入代理修（会改同一批文件的并行任务用 `isolation: 'worktree'`），再检查；连续两轮没有进展就停，在返回值里说明剩下什么。

**最后的完整性检查**：派一个只读代理核对漏掉的要求、没读的文件或来源、没验证的说法，结果一起 `return`。

## 规模与汇报

- 规模跟着用户的说法走：「看一下」「快速查」几个代理、每个结论一名复核者；「彻底」「全面审计」可以几十个，每个关键结论三名以上复核者，再加汇总阶段。超过 25 个子 Agent 时运行卡会标「大规模」。
- 机械性的批量改动可以交给更快、更便宜的模型（`model`），难点留给强模型。
- 汇报时正文写结论和需要用户决定的事；派了哪些阶段、哪些结论复核过、哪些没有，放进补充说明。只查了一部分（只看前 N 个文件、抽样）要说清楚漏了什么，不能写成像是全覆盖。工作流失败或部分子 Agent 失败不能称为任务成功。
