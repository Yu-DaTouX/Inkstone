import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'inkstone-model-bot-'))
try {
  await build({
    entryPoints: {
      brand: 'src/shared/model-brand.ts',
      tool: 'src/renderer/src/features/session/subagent-tool.ts',
      draw: 'src/renderer/src/patterns/model-bot/draw.ts'
    },
    bundle: true, platform: 'node', format: 'esm', outdir: temp, outExtension: { '.js': '.mjs' }, logLevel: 'silent'
  })
  const load = (name) => import(pathToFileURL(resolve(temp, `${name}.mjs`)).href)
  const { modelBrand, splitModelRef, MODEL_BRANDS } = await load('brand')
  const { subagentToolLook, subagentActiveTool } = await load('tool')
  const { BOT_FORMS, IDLE_TOOL, TOOL_LINGER_SECONDS, followTool, poseAt, settlesAt, motionGain } = await load('draw')
  let count = 0
  const expect = (ref, brand, text) => {
    assert.equal(modelBrand(ref), brand, `${text}：${JSON.stringify(ref)}`)
    count += 1
  }

  expect('anthropic/claude-sonnet-5-5', 'claude', 'Anthropic 直连')
  expect('claude-bridge/claude-opus-5-5', 'claude', 'Claude Code 订阅桥')
  expect({ provider: 'anthropic', id: 'claude-haiku-4-5' }, 'claude', '运行快照的 provider/id 对象')
  expect('openai/gpt-5.5', 'codex', 'OpenAI 直连')
  expect('openai-codex/gpt-6-sol', 'codex', 'ChatGPT 套餐 Codex')
  expect('openai/o3-mini', 'codex', 'OpenAI o 系列')
  expect('azure-openai-responses/gpt-5', 'codex', 'Azure OpenAI 响应接口')
  expect('deepseek/deepseek-v4.1-flash', 'deepseek', 'DeepSeek 直连')
  expect('google/gemini-3.5-flash', 'gemini', 'Google 直连')
  expect('google-vertex/gemini-2.5-pro', 'gemini', 'Vertex')
  expect('gemini-cli/gemini-3.1-pro-preview', 'gemini', 'Gemini CLI 订阅')
  expect('google/gemma-4-31b-it', 'gemini', 'Google 提供的其他模型仍按 provider')
  expect('moonshotai/kimi-k3', 'kimi', 'Moonshot 国际站')
  expect('moonshotai-cn/kimi-k2.7-code', 'kimi', 'Moonshot 国内站')
  expect('kimi-coding/k3', 'kimi', 'Kimi Coding 的 id 不含品牌词也按 provider')
  expect('zai/glm-5.3', 'glm', 'Z.ai')
  expect('zai-coding-cn/glm-4.6v', 'glm', '智谱国内编码套餐')
  expect('xai/grok-4.7', 'grok', 'xAI')
  expect('qwen/qwen3-coder-plus', 'qwen', 'Qwen 自有 provider')

  expect('qwen-token-plan-cn/qwen3.8-max', 'qwen', '百炼套餐上的 Qwen')
  expect('qwen-token-plan-cn/deepseek-v4-flash', 'deepseek', '百炼套餐托管的 DeepSeek 按模型 id')
  expect('qwen-token-plan/glm-5.2', 'glm', '百炼套餐托管的 GLM 按模型 id')
  expect('qwen-token-plan-cn/kimi-k2.6', 'kimi', '百炼套餐托管的 Kimi 按模型 id')
  expect('qwen-token-plan-cn/MiniMax-M2.5', 'pi', '百炼套餐托管的其他厂商不冒充 Qwen')
  expect('github-copilot/claude-opus-5.5', 'claude', 'Copilot 托管的 Claude')
  expect('github-copilot/gpt-5.5', 'codex', 'Copilot 托管的 GPT')
  expect('opencode-go/qwen3.8-flash', 'qwen', 'OpenCode Go 托管的 Qwen')
  expect('opencode-go/minimax-m3', 'pi', 'OpenCode Go 托管的其他模型')
  expect('amazon-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude', 'Bedrock 区域前缀')
  expect('amazon-bedrock/openai.gpt-oss-120b-1:0', 'codex', 'Bedrock 上的 OpenAI 开源权重')

  expect('openrouter/anthropic/claude-sonnet-4.5', 'claude', 'OpenRouter 厂商前缀')
  expect('openrouter/openai/o4-mini', 'codex', 'OpenRouter 上的 o 系列')
  expect('openrouter/deepseek/deepseek-chat-v3.1', 'deepseek', 'OpenRouter DeepSeek')
  expect('openrouter/qwen/qwen3-max', 'qwen', 'OpenRouter Qwen')
  expect('openrouter/google/gemini-2.5-flash', 'gemini', 'OpenRouter Gemini')
  expect('openrouter/moonshotai/kimi-k2', 'kimi', 'OpenRouter Kimi')
  expect('openrouter/z-ai/glm-4.6', 'glm', 'OpenRouter GLM')
  expect('openrouter/x-ai/grok-4', 'grok', 'OpenRouter Grok')
  expect('openrouter/meta-llama/llama-4-maverick', 'pi', 'OpenRouter 其他厂商')
  expect('openrouter/openrouter/auto', 'pi', 'OpenRouter 自动路由')
  expect('vercel-ai-gateway/anthropic/claude-opus-5', 'claude', 'Vercel 网关厂商前缀')
  expect({ provider: 'openrouter', id: 'x-ai/grok-4.7' }, 'grok', '对象形式的嵌套 id')
  expect('commandcode/deepseek/deepseek-v4.1-flash', 'deepseek', '自定义 provider 下的厂商前缀')
  expect('my-relay/claude-sonnet-4-5', 'claude', '自定义中转按模型 id')
  expect('relay/chatglm3-6b', 'glm', 'ChatGLM')
  expect('relay/qwq-32b', 'qwen', 'QwQ')

  expect('claude-sonnet-5-5', 'claude', '只有模型 id')
  expect('sonnet', 'claude', 'pi 模型别名')
  expect('*opus*', 'claude', '通配写法')
  expect('anthropic/claude-sonnet-5-5:high', 'claude', '带思考档位后缀')
  expect('gpt-5.5-codex', 'codex', '只有模型 id 的 Codex')
  expect('DeepSeek-V4-Pro', 'deepseek', '大小写不敏感')
  expect('custom/llama-4', 'pi', '未知模型')
  expect('mistral/mistral-large-latest', 'pi', '未收录厂商')
  expect('custom/logpt-7b', 'pi', 'gpt 必须是独立词首')
  expect('custom/omni-large', 'pi', 'o 系列必须是 o 加数字')
  expect('', 'pi', '空字符串')
  expect(undefined, 'pi', '缺失模型')
  expect(null, 'pi', '空值')
  expect({ provider: '', id: '' }, 'pi', '空对象')

  assert.deepEqual(splitModelRef('openrouter/anthropic/claude-sonnet-4.5:medium'), { provider: 'openrouter', id: 'anthropic/claude-sonnet-4.5' })
  assert.deepEqual(splitModelRef('claude-sonnet-5-5'), { provider: '', id: 'claude-sonnet-5-5' })
  count += 2
  assert.deepEqual([...MODEL_BRANDS].sort(), ['claude', 'codex', 'deepseek', 'gemini', 'glm', 'grok', 'kimi', 'pi', 'qwen'])
  count += 1

  const looks = {
    command: ['bash', 'Bash', 'powershell', 'shell', 'exec', 'codemode', 'run_terminal_cmd', 'execute_command', 'mcp__desktop__shell'],
    read: ['read', 'Read', 'ls', 'mcp__fs__read_file', 'list_dir', 'functions.view'],
    search: ['grep', 'Grep', 'glob', 'find', 'rg', 'search', 'web_search', 'web_fetch', 'fetch', 'mcp__exa__web_search', 'mcp__docs__fetch'],
    edit: ['edit', 'write', 'multi_edit', 'apply_patch', 'str_replace_editor', 'create_file', 'mcp__fs__write_file']
  }
  for (const [look, names] of Object.entries(looks)) {
    for (const name of names) {
      assert.equal(subagentToolLook(name), look, `工具外观：${name}`)
      count += 1
    }
  }
  for (const name of ['subagent', 'todo_write', 'ask_user', 'mcp__linear__create_issue', '']) {
    assert.equal(subagentToolLook(name), null, `其余工具保持思考：${name}`)
    count += 1
  }
  assert.equal(subagentToolLook('bash', { command: 'yan search "electron ipc"' }), 'search', '命令行里的 yan search 算搜索')
  assert.equal(subagentToolLook('bash', { command: 'cd src && yan fetch https://example.com' }), 'search', '命令行里的 yan fetch 算搜索')
  assert.equal(subagentToolLook('bash', 'yan.cmd search pi'), 'search', '运行快照标签里的 yan search 算搜索')
  assert.equal(subagentToolLook('bash', { command: 'npm run yan-build' }), 'command', '其他命令仍是跑命令')
  count += 4

  const assistant = (toolCalls, text = '') => ({ id: `m${Math.random()}`, role: 'assistant', text, toolCalls })
  const call = (id, name, extra = {}) => ({ id, name, args: {}, status: 'ok', ...extra })
  const active = (transcript, snapshot) => subagentActiveTool({ transcript }, snapshot)
  assert.deepEqual(active([assistant([call('a', 'bash')])]), { look: 'command', id: 'a' }, '最近一条助手消息里没有结果的调用算在运行')
  assert.equal(active([assistant([call('a', 'bash', { output: '' })])]), null, '有结果（哪怕为空）即已结束')
  assert.equal(active([assistant([call('a', 'bash', { cancelled: true })])]), null, '已取消的不算')
  assert.equal(active([assistant([call('a', 'read')]), assistant(undefined, '读完了')]), null, '之后已有新助手消息时不再沿用旧调用')
  assert.deepEqual(active([assistant([call('a', 'grep'), call('b', 'subagent')])]), { look: 'search', id: 'a' }, '并行调用跳过没有外观的工具')
  assert.deepEqual(active([assistant([call('a', 'read')]), { id: 'u', role: 'user', text: '补充' }]), { look: 'read', id: 'a' }, '用户插话不打断正在运行的调用')
  assert.equal(active([assistant([call('a', 'edit', { parentToolCallId: 'p' })])]), null, '嵌套调用不算')
  assert.equal(active([]), null, '空记录')
  const running = (tool) => ({ phase: { kind: 'running', since: 0, activity: 'tool', ...(tool ? { tool } : {}) } })
  assert.deepEqual(active([assistant([call('a', 'bash')])], running({ name: 'grep', label: 'grep', callId: 's1' })), { look: 'search', id: 's1' }, '运行快照带工具时优先')
  assert.deepEqual(active([assistant([call('a', 'bash')])], running()), { look: 'command', id: 'a' }, '快照没有工具时退回记录')
  count += 10

  let state = followTool(IDLE_TOOL, { look: 'command', id: 'a' }, 0)
  assert.deepEqual(state, { look: 'command', id: 'a', until: 0 })
  assert.equal(followTool(state, { look: 'command', id: 'a' }, 1), state, '同一调用不重置')
  state = followTool(state, null, 2)
  assert.equal(state.until, 2 + TOOL_LINGER_SECONDS, '调用结束后保持 10 秒')
  assert.equal(followTool(state, null, 11.9), state, '余韵内保持原外观')
  assert.equal(followTool(state, null, 12), IDLE_TOOL, '10 秒后回到思考')
  assert.deepEqual(followTool(state, { look: 'read', id: 'b' }, 5), { look: 'read', id: 'b', until: 0 }, '余韵中来了新调用立即切换')
  assert.deepEqual(followTool(state, { look: 'command', id: 'a' }, 5), { look: 'command', id: 'a', until: 0 }, '同一调用回来取消余韵')
  assert.equal(followTool(IDLE_TOOL, null, 5), IDLE_TOOL)
  count += 8

  const at = (t, tool, form = BOT_FORMS.claude, still = false) => poseAt('work', form, { t, seed: 0, since: 0, entrance: false, restTurn: 30, still }, tool)
  const body = ({ badge, cue, cueAlpha, ...rest }) => rest
  for (const tool of ['command', 'read', 'edit', 'search']) {
    for (const t of [0.3, 2, 7.7, 25]) {
      assert.deepEqual(body(at(t, tool, BOT_FORMS.claude, true)), body(at(t, null, BOT_FORMS.claude, true)), `减少动态时 ${tool} 身体静止`)
      assert.deepEqual(at(t, tool, BOT_FORMS.claude, true), at(0.3, tool, BOT_FORMS.claude, true), `减少动态时 ${tool} 道具静止`)
    }
    assert.equal(at(2, tool, BOT_FORMS.claude, true).badge, tool, `减少动态时 ${tool} 仍显示静态道具`)
    count += 2
  }
  assert.equal(at(2, null, BOT_FORMS.claude, true).badge, 'think', '减少动态时思考仍显示静态泡泡')
  count += 1
  const samples = (from, to, tool, form) => Array.from({ length: 80 }, (_, i) => at(from + ((to - from) * i) / 80, tool, form))
  const reading = samples(0, 6.8, 'read')
  assert.ok(reading.every((p) => p.dy === 0 && p.dx === 0 && p.turn === 30 && p.scale === 1 && p.squash === 0 && p.tilt === 0), '读文件时身体不动、不自转')
  assert.ok(Math.min(...reading.map((p) => p.yaw)) < -0.3 && Math.max(...reading.map((p) => p.yaw)) > 0.3, '读文件时眼睛左右扫')
  assert.ok(at(1.0, 'read').pitch < at(1.7 + 1.0, 'read').pitch && at(1.7 + 1.0, 'read').pitch < at(3 * 1.7 + 1.0, 'read').pitch, '逐行略向下')
  assert.ok(at(4 * 1.7 + 1.0, 'read').pitch === at(1.0, 'read').pitch, '一页读完回到顶行')
  const bursting = samples(0, 3, 'command')
  const pausing = samples(3.01, 4.49, 'command')
  assert.ok(Math.min(...bursting.map((p) => p.dy)) < -0.04, '跑命令时按节拍上下点动')
  assert.ok(pausing.every((p) => p.dy === 0 && p.squash === 0 && p.turn === pausing[0].turn), '每 3 秒点动后停 1.5 秒，停时不转')
  assert.ok(bursting.at(-1).turn > bursting[0].turn, '会转的品牌点动时自转')
  assert.ok(samples(0, 3, 'command', BOT_FORMS.deepseek).every((p) => p.turn === 30), '不转的品牌不转')
  assert.ok(Math.min(...samples(24, 28.5, 'command').map((p) => p.dy)) > -0.025, '命令超过 20 秒换成更慢更轻的点动')
  const editing = samples(0, 3.2, 'edit')
  assert.ok(editing.every((p) => p.dy >= 0 && p.turn === 30) && Math.max(...editing.map((p) => p.dy)) > 0.02, '编辑时轻轻点头')
  count += 10

  assert.ok(motionGain(16) > motionGain(22) && motionGain(22) > motionGain(32) && motionGain(32) > motionGain(64) && motionGain(64) === 1 && motionGain(128) === 1, '小尺寸放大动作幅度，64px 起不放大')
  const sized = (size, mood, tool, t, entrance = false) => poseAt(mood, BOT_FORMS.claude, { t, seed: 0, since: 0, entrance, restTurn: 0, still: false, size }, tool)
  const span = (size, mood, tool, key, to) => {
    const values = Array.from({ length: 160 }, (_, i) => sized(size, mood, tool, (to * i) / 160)[key])
    return Math.max(...values) - Math.min(...values)
  }
  assert.ok(span(16, 'work', 'read', 'yaw', 6.8) > span(64, 'work', 'read', 'yaw', 6.8), '读文件在小尺寸下眼睛扫得更开')
  assert.ok(span(16, 'work', null, 'tilt', 4.8) > span(64, 'work', null, 'tilt', 4.8) && span(64, 'work', null, 'tilt', 4.8) > 0, '思考时随视线歪头，小尺寸更明显')
  assert.ok(span(16, 'work', 'edit', 'squash', 0.8) > 0.05, '编辑时按下有压扁')
  assert.ok(Math.max(...Array.from({ length: 60 }, (_, i) => sized(32, 'work', 'command', i * 0.05).squash)) > 0.03 && Math.min(...Array.from({ length: 60 }, (_, i) => sized(32, 'work', 'command', i * 0.05).squash)) < 0, '跑命令时起跳拉伸、落地压扁')
  assert.ok(span(32, 'ask', null, 'dy', 1.9) > 0.025 && span(32, 'ask', null, 'tilt', 1.9) > 0.1, '等你确认时连跳两下再左右摇摆')
  assert.ok(span(16, 'work', 'search', 'yaw', 1.6) > 0.8 && span(16, 'work', 'search', 'dx', 1.6) > 0.02 && span(16, 'work', 'search', 'cue', 1.6) > 1.5, '搜索时左右张望，放大镜跟着扫')
  assert.deepEqual(['think', 'search', 'read', 'command', 'edit'].map((look) => sized(16, 'work', look === 'think' ? null : look, 1).badge), ['think', 'search', 'read', 'command', 'edit'], '每种工作状态都有自己的道具')
  assert.equal(sized(16, 'ask', null, 1).badge, 'ask', '等你确认显示问号')
  assert.ok(['done', 'fail', 'rest', 'wake'].every((mood) => sized(16, mood, null, 0.2, true).badge === null && sized(16, mood, null, 5).badge === null), '终态和醒来不显示道具')
  assert.ok(Object.values(BOT_FORMS).every((form) => poseAt('fail', form, { t: 3, seed: 0, since: 0, entrance: false, restTurn: 0, still: false, size: 16 }).crossed === 1), '失败时所有品牌都画 X 眼')
  count += 1
  count += 4
  assert.ok(Array.from({ length: 160 }, (_, i) => sized(16, 'work', 'command', i * 0.03)).every((p) => p.squash < 0.1 && p.squash > -0.06 && Math.abs(p.tilt) < 0.2), '动作幅度有上限')
  count += 7

  for (const mood of ['done', 'fail', 'wake']) {
    const end = settlesAt(mood, true)
    assert.ok(end > 0 && end <= 1.6, `${mood} 有入场动作且很快结束`)
    assert.deepEqual(sized(16, mood, null, end + 0.01, true), sized(16, mood, null, end + 3, true), `${mood} 入场后静止`)
    assert.deepEqual(sized(16, mood, null, 0.3, false), sized(16, mood, null, 5, false), `${mood} 非入场时不动`)
    count += 3
  }
  assert.ok(span(16, 'done', null, 'dy', 0.6) === 0 && Array.from({ length: 30 }, (_, i) => sized(16, 'done', null, i * 0.02, true).dy).some((dy) => dy < -0.03), '完成时开心地跳一下')
  for (const mood of ['ask', 'done', 'fail', 'wake', 'rest']) {
    const still = (t) => poseAt(mood, BOT_FORMS.claude, { t, seed: 0, since: 0, entrance: true, restTurn: 0, still: true, size: 16 })
    assert.deepEqual(still(0.2), still(3.3), `减少动态时 ${mood} 静止`)
  }
  count += 6

  console.log(`model-bot: ${count} 项通过`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
