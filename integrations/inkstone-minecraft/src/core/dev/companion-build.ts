import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { companionModDir } from './assets.ts'
import { COMPANION_VARIANTS, findCompanionJar, type CompanionVariant } from './companion.ts'
import { defaultFetchText, GRADLE_SERVICES, type FetchText } from './fabric-meta.ts'
import { cleanGradleOutput, ensureWrapper, findLocalGradles, parseGradleErrors, runGradle } from './gradle.ts'

export interface CompanionBuildResult {
  ok: boolean
  jar: string | null
  durationMs: number
  errors: string[]
  output: string
}

export async function currentGradleVersion(fetchText: FetchText = defaultFetchText): Promise<string> {
  try {
    const version = (JSON.parse(await fetchText(`${GRADLE_SERVICES}/versions/current`)) as { version?: unknown }).version
    if (typeof version === 'string' && version) return version
  } catch {
  }
  const local = (await findLocalGradles())[0]
  if (!local) throw new Error('无法确定 Gradle 版本（离线且本机没有 Gradle 发行包）')
  return local.version
}

export async function buildCompanionMod(options: { javaPath: string; gradleVersion?: string; onLine?: (line: string) => void; dir?: string; variant?: CompanionVariant }): Promise<CompanionBuildResult> {
  const variant = options.variant ?? COMPANION_VARIANTS[0]
  const dir = options.dir ?? companionModDir(variant.subdir)
  const wrapperReady = existsSync(join(dir, 'gradle', 'wrapper', 'gradle-wrapper.jar'))
  if (!wrapperReady) await ensureWrapper(dir, options.gradleVersion ?? (await currentGradleVersion()), options.javaPath)
  const result = await runGradle(dir, ['build'], { javaPath: options.javaPath, args: ['--no-configuration-cache'], onLine: options.onLine })
  const jar = result.ok ? await findCompanionJar([join(dir, 'build', 'libs')], variant) : null
  return { ok: result.ok && !!jar, jar, durationMs: result.durationMs, errors: result.ok ? [] : parseGradleErrors(result.output), output: cleanGradleOutput(result.output).slice(-20_000) }
}
