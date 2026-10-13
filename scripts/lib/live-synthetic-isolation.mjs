export function defaultLiveCases(cases) {
  return Object.keys(cases).filter(name => cases[name].cost === 0 && !cases[name].needsCredentials && !cases[name].needsDownload)
}

export function validateSyntheticSelection(names, cases, isolated) {
  if (!isolated) throw new Error('Synthetic-only live checks require an isolated data directory')
  for (const name of names) {
    if (cases[name]?.cost !== 0 || cases[name]?.needsCredentials) throw new Error(`Synthetic-only live checks refuse model-dependent case: ${name}`)
  }
}

export function syntheticEnvironment(env) {
  const result = { ...env, PI_OFFLINE: '1' }
  for (const key of Object.keys(result)) {
    if (/^(ANTHROPIC|OPENAI|GOOGLE|GEMINI|AWS|AZURE|COMMANDCODE|CLAUDE)_|API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^CLAUDECODE$|^YAN_CLI_|^YAN_SESSION_ID$|^YAN_PROJECT_ID$|^ELECTRON_RUN_AS_NODE$|^ELECTRON_RENDERER_URL$/.test(key)) delete result[key]
  }
  return result
}
