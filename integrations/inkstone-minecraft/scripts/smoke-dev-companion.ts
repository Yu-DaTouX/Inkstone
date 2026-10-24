import { buildCompanionMod } from '../src/core/dev/companion-build.ts'
import { detectJava, pickJava } from '../src/core/dev/java.ts'

const java = process.argv[2] ?? pickJava(await detectJava(), 25)?.path
if (!java) {
  console.error('需要 Java 25 运行 Gradle（Loom 1.19 的要求）')
  process.exit(2)
}
const result = await buildCompanionMod({ javaPath: java, onLine: (line) => process.stdout.write(`${line}\n`) })
console.log(JSON.stringify({ ok: result.ok, jar: result.jar, durationMs: result.durationMs, errors: result.errors }, null, 2))
process.exit(result.ok ? 0 : 1)
