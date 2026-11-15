const TOOL_TOKEN_KEY = Symbol.for('yan.hostToolToken')

export function takeHostToolToken(env = process.env) {
  if (typeof env.YAN_TOOL_TOKEN === 'string' && env.YAN_TOOL_TOKEN) globalThis[TOOL_TOKEN_KEY] = env.YAN_TOOL_TOKEN
  delete env.YAN_TOOL_TOKEN
  return globalThis[TOOL_TOKEN_KEY]
}

takeHostToolToken()

export default function hostToolToken() {
  takeHostToolToken()
}
