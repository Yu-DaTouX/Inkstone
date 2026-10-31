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
  const { IDLE_TOOL, TOOL_LINGER_SECONDS, followTool } = await load('draw')
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

  console.log(`model-bot: ${count} 项通过`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
