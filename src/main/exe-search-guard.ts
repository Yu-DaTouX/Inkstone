const KEY = 'NoDefaultCurrentDirectoryInExePath'
const windows = process.platform === 'win32'
const preset = windows && process.env[KEY] !== undefined

if (windows && !preset) process.env[KEY] = '1'

export function withoutExeSearchGuard(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!windows || preset) return env
  const { [KEY]: _, ...rest } = env
  return rest
}
