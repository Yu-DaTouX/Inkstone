const FAST_CODEX_MODEL = /^gpt-6(?:\.\d+)?-(?:sol|terra|astra|luna)(?:$|-)/

export function fastModeSupported(model: { provider?: string; id?: string } | null | undefined): boolean {
  return model?.provider === 'openai-codex' && FAST_CODEX_MODEL.test(String(model.id ?? ''))
}
