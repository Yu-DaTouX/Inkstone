const SOURCES = import.meta.glob<string>('../assets/provider-icons/*.{png,jpg}', { query: '?url', import: 'default', eager: true })

const URLS = new Map<string, string>()
for (const [path, url] of Object.entries(SOURCES)) {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
  URLS.set(name, url)
}

const ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(anthropic|claude-bridge|claude-code|claude)$/, 'anthropic'],
  [/^(openai|openai-codex|chatgpt|codex)$/, 'openai'],
  [/^azure-openai-responses$/, 'azure-openai-responses'],
  [/^deepseek/, 'deepseek'],
  [/^(qwen|alibaba)/, 'qwen'],
  [/^google-vertex/, 'google-vertex'],
  [/^(google|gemini)/, 'google'],
  [/^(moonshot|moonshotai)/, 'moonshotai'],
  [/^kimi/, 'kimi-coding'],
  [/^(zai|zhipu|bigmodel|glm)/, 'zai'],
  [/^(xai|x-ai|grok)$/, 'xai'],
  [/^xiaomi/, 'xiaomi'],
  [/^minimax/, 'minimax'],
  [/^cloudflare/, 'cloudflare'],
  [/^(github-copilot|copilot)$/, 'github-copilot'],
  [/^opencode/, 'opencode'],
  [/^(command-?code)$/, 'commandcode']
]

export function providerFavicon(provider: string): string | null {
  const id = provider.trim().toLowerCase()
  if (!id) return null
  const direct = URLS.get(id)
  if (direct) return direct
  for (const [pattern, name] of ALIASES) if (pattern.test(id)) return URLS.get(name) ?? null
  return null
}
