import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePi } from './protocol'
import { trustStatus } from './project-trust'
import { PI_AGENT_DIR } from './paths'
import {
  parsePiBuiltinNames,
  piExtensionSkipArgs,
  planPiExtensionSkip,
  type PiExtensionSkip,
  type ResolvedPiExtension
} from '../shared/pi-extension-skip'

const PROBE_TIMEOUT_MS = 15_000

const PROBE_SOURCE = [
  "import { join } from 'node:path'",
  "import { pathToFileURL } from 'node:url'",
  'const [home, cwd, agentDir, trusted, names] = process.argv.slice(2)',
  "const pi = await import(pathToFileURL(join(home, 'dist', 'bundle', 'index.js')).href)",
  "const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: trusted === '1' })",
  "const manager = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager, builtinExtensions: names.split(',') })",
  "const resolved = await manager.resolve(async () => 'skip')",
  'process.stdout.write(JSON.stringify(resolved.extensions.map((item) => ({ path: item.path, enabled: item.enabled === true }))))'
].join('\n')

export async function readPiBuiltinNames(home: string): Promise<string[] | null> {
  const dir = join(home, 'dist', 'bundle', 'chunks')
  let found: string[] | null = null
  for (const file of await readdir(dir).catch(() => [] as string[])) {
    if (!file.endsWith('.js')) continue
    const text = await readFile(join(dir, file), 'utf8').catch(() => '')
    if (!text.includes('builtInExtensions=[')) continue
    if (found) return null
    found = parsePiBuiltinNames(text)
    if (!found) return null
  }
  return found
}

export async function resolvePiExtensions(opts: { cwd: string; piBin?: string; agentDir?: string }): Promise<ResolvedPiExtension[] | null> {
  const probe = resolvePi({ override: opts.piBin })
  if (probe.source === 'shell' || !probe.home || probe.cmd !== process.execPath) return null
  const agentDir = opts.agentDir ?? PI_AGENT_DIR
  const builtins = await readPiBuiltinNames(probe.home)
  if (!builtins) return null
  const trusted = await trustStatus(opts.cwd).then((status) => status.trusted, () => false)
  const dir = await mkdtemp(join(tmpdir(), 'yan-pi-ext-'))
  try {
    const script = join(dir, 'resolve.mjs')
    await writeFile(script, PROBE_SOURCE, 'utf8')
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(probe.cmd, [script, probe.home!, opts.cwd, agentDir, trusted ? '1' : '0', builtins.join(',')], {
        cwd: opts.cwd,
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' }
      }, (error, out) => error ? reject(error) : resolve(String(out)))
    })
    const parsed: unknown = JSON.parse(stdout)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((item): item is ResolvedPiExtension =>
      !!item && typeof item === 'object' && typeof (item as ResolvedPiExtension).path === 'string' && typeof (item as ResolvedPiExtension).enabled === 'boolean')
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface PiExtensionSkipLaunch {
  args: string[]
  skip: PiExtensionSkip
}

export async function piExtensionSkipLaunch(input: {
  stderr: readonly string[]
  args: readonly string[]
  userPaths?: readonly string[]
  cwd: string
  piBin?: string
  resolve?: typeof resolvePiExtensions
}): Promise<PiExtensionSkipLaunch | null> {
  const hostPaths = hostPiExtensionPaths(input.args, input.userPaths ?? [])
  const plan = planPiExtensionSkip(input.stderr, hostPaths)
  if (plan.kind === 'none') return null
  const discovery = !input.args.includes('--no-extensions')
  const resolved = discovery ? await (input.resolve ?? resolvePiExtensions)({ cwd: input.cwd, piBin: input.piBin }) : null
  return piExtensionSkipArgs({ args: input.args, hostPaths, plan, resolved })
}

export function hostPiExtensionPaths(args: readonly string[], userPaths: readonly string[]): string[] {
  const user = new Set(userPaths)
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === '--extension' || args[i] === '-e') && args[i + 1] !== undefined) {
      const path = args[++i]
      if (!user.has(path)) out.push(path)
    }
  }
  return out
}

export function reapplyPiExtensionSkip(input: {
  args: readonly string[]
  skip: PiExtensionSkip
  resolved: readonly ResolvedPiExtension[] | null
  sourceCwd: string
  targetCwd: string
}): string[] {
  const relocate = (path: string): string => {
    const from = input.sourceCwd.replace(/[\\/]+$/, '')
    const lower = path.toLowerCase().replace(/\\/g, '/')
    const base = from.toLowerCase().replace(/\\/g, '/')
    return lower.startsWith(`${base}/`) ? join(input.targetCwd, path.slice(from.length + 1)) : path
  }
  const culprits = input.skip.extensions.map((item) => ({ ...item, path: relocate(item.path), owner: undefined }))
  const hostPaths = hostPiExtensionPaths(input.args, [])
  const plan = input.skip.mode === 'some' && culprits.length > 0
    ? { kind: 'skip' as const, culprits }
    : { kind: 'all-user' as const, culprits }
  return piExtensionSkipArgs({ args: input.args, hostPaths, plan, resolved: input.resolved }).args
}
