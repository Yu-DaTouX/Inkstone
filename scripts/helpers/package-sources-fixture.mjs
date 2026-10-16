import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
export function writePackageSourcesForTest(settingsPath, sources) {
  let json
  try { json = JSON.parse(readFileSync(settingsPath, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; json = {} }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Invalid settings fixture')
  json.packages = sources
  const temp = `${settingsPath}.${randomUUID()}.tmp`
  try {
    const handle = openSync(temp, 'wx', 0o600)
    try { writeFileSync(handle, JSON.stringify(json, null, 2)); fsyncSync(handle) } finally { closeSync(handle) }
    renameSync(temp, settingsPath)
  } catch (error) { rmSync(temp, { force: true }); throw error }
}
