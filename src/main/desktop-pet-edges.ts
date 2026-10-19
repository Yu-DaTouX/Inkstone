import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DesktopPetEdgeStatus } from '../shared/desktop-pet'

const EDGE_PROFILE = 'edge-v2'
const PARALLEL = 3
const FILE_TIMEOUT_MS = 120_000

const GREEN_LIMIT = "geq=r='r(X,Y)':g='min(g(X,Y),max(r(X,Y),b(X,Y)))':b='b(X,Y)'"

const FILTER_GRAPH = [
  '[0:v]format=rgba,split[src][fora]',
  '[fora]alphaextract,split=5[a0][a1][a2][a3][a4]',
  '[a1]dilation,dilation[ad]',
  '[a2]erosion[ae]',
  "[ad][ae]blend=all_mode=difference,lut=y='min(255,val*3)',format=gbrp[thin]",
  '[a3]dilation,dilation,dilation,dilation[wd]',
  '[a4]erosion,erosion,erosion,erosion[we]',
  "[wd][we]blend=all_mode=difference,lut=y='if(gt(val,8),255,0)',format=gbrp[wide]",
  '[src]format=gbrp,split[orig][forlim]',
  `[forlim]${GREEN_LIMIT}[lim]`,
  '[orig][lim][wide]maskedmerge[clean]',
  `[clean]split[c1][c2];[c2]erosion,${GREEN_LIMIT}[dark]`,
  '[c1][dark][thin]maskedmerge,format=rgba[col]',
  "[a0]lut=y='if(lt(val,56),0,min(255,(val-56)*255/150))'[am]",
  '[col][am]alphamerge,format=yuva420p'
].join(';')

interface EdgeMarker {
  profile: string
  version: string
  files: string[]
}

export interface EdgeJobInput {
  ffmpeg: string | null
  version: string
  sourceDir: string
  targetDir: string
  workDir: string
  log(text: string): void
}

let status: DesktopPetEdgeStatus = { state: 'idle', done: 0, total: 0 }
let running: Promise<void> | null = null
let cancelled = false
const children = new Set<ChildProcess>()

export function desktopPetEdgeStatus(): DesktopPetEdgeStatus {
  return { ...status }
}

function markerPath(targetDir: string): string {
  return join(targetDir, '.inkstone-edges.json')
}

async function readMarker(targetDir: string): Promise<EdgeMarker | null> {
  try {
    const raw = JSON.parse(await readFile(markerPath(targetDir), 'utf8')) as Partial<EdgeMarker>
    if (typeof raw.profile !== 'string' || typeof raw.version !== 'string' || !Array.isArray(raw.files)) return null
    return { profile: raw.profile, version: raw.version, files: raw.files.filter((file): file is string => typeof file === 'string') }
  } catch {
    return null
  }
}

function refineOne(ffmpeg: string, input: string, output: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error', '-y',
      '-c:v', 'libvpx-vp9', '-i', input,
      '-filter_complex', FILTER_GRAPH,
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '26', '-b:v', '0',
      '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0',
      '-metadata:s:v:0', 'alpha_mode=1', '-an', output
    ]
    let stderr = ''
    let child: ChildProcess
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error))
      return
    }
    children.add(child)
    const timer = setTimeout(() => child.kill(), FILE_TIMEOUT_MS)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      children.delete(child)
      resolve(error.message)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      children.delete(child)
      resolve(code === 0 ? null : stderr.trim().split(/\r?\n/).pop() || `ffmpeg 退出码 ${code ?? 'null'}`)
    })
  })
}

async function runJob(input: EdgeJobInput): Promise<void> {
  if (!input.ffmpeg) {
    status = { state: 'skipped', done: 0, total: 0, message: 'no-ffmpeg' }
    return
  }
  const marker = await readMarker(input.targetDir)
  if (marker && marker.profile === EDGE_PROFILE && marker.version === input.version) {
    status = { state: 'done', done: marker.files.length, total: marker.files.length }
    return
  }
  const names = (await readdir(input.sourceDir)).filter((name) => name.toLowerCase().endsWith('.webm')).sort()
  status = { state: 'running', done: 0, total: names.length }
  await mkdir(input.targetDir, { recursive: true })
  await rm(input.workDir, { recursive: true, force: true })
  await mkdir(input.workDir, { recursive: true })
  const finished: string[] = []
  const failures: string[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (!cancelled && next < names.length) {
      const name = names[next++]
      const temp = join(input.workDir, name)
      const error = await refineOne(input.ffmpeg!, join(input.sourceDir, name), temp)
      if (cancelled) return
      if (error) failures.push(`${name}: ${error}`)
      else {
        try {
          await rename(temp, join(input.targetDir, name))
          finished.push(name)
        } catch (renameError) {
          failures.push(`${name}: ${renameError instanceof Error ? renameError.message : String(renameError)}`)
        }
      }
      status = { ...status, done: finished.length + failures.length }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, names.length) }, () => worker()))
  await rm(input.workDir, { recursive: true, force: true }).catch(() => undefined)
  if (cancelled) {
    status = { state: 'idle', done: 0, total: 0 }
    return
  }
  for (const failure of failures.slice(0, 5)) input.log(`[inkstone] 修边缘失败 ${failure}`)
  if (failures.length) {
    status = { state: 'failed', done: finished.length, total: names.length, message: failures[0] }
    return
  }
  await writeFile(markerPath(input.targetDir), `${JSON.stringify({ profile: EDGE_PROFILE, version: input.version, files: finished }, null, 2)}\n`, 'utf8')
  input.log(`[inkstone] 已修好 ${finished.length} 个动画的边缘`)
  status = { state: 'done', done: finished.length, total: names.length }
}

export function startDesktopPetEdgeFix(input: EdgeJobInput): void {
  if (running || !existsSync(input.sourceDir)) return
  cancelled = false
  if (input.ffmpeg && status.state !== 'done') status = { state: 'running', done: 0, total: status.total }
  running = runJob(input)
    .catch((error) => {
      status = { state: 'failed', done: status.done, total: status.total, message: error instanceof Error ? error.message : String(error) }
    })
    .finally(() => {
      running = null
    })
}

export async function cancelDesktopPetEdgeFix(): Promise<void> {
  cancelled = true
  for (const child of children) child.kill()
  await running
  status = { state: 'idle', done: 0, total: 0 }
}

export function cancelDesktopPetEdgeFixSync(): void {
  cancelled = true
  for (const child of children) child.kill()
}
