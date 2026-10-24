import { createFabricProject } from '../src/core/dev/create-project.ts'

const [targetDir, minecraftVersion = '1.21.1', modId = 'inkdemo', mappings = 'yarn', gradle] = process.argv.slice(2)
if (!targetDir) {
  console.error('用法：node scripts/smoke-dev-create.ts <目标目录> [MC 版本] [mod id] [yarn|mojmap] [Gradle 版本]')
  process.exit(2)
}
const result = await createFabricProject({
  minecraftVersion,
  modId,
  packageName: `dev.inkstone.${modId.replaceAll('-', '_')}`,
  targetDir,
  modName: 'Inkstone Demo',
  mappings: mappings === 'mojmap' ? 'mojmap' : 'yarn',
  versions: gradle ? { gradle } : undefined
})
console.log(JSON.stringify(result, null, 2))
