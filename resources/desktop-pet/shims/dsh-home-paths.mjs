export function resolveDshHome() {
  const home = process.env.DSH_HOME
  if (!home) throw new Error('DSH_HOME is not set')
  return home
}
