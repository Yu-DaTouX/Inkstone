import { listInstances } from '../src/core/instances.ts'
import { detectJava } from '../src/core/java.ts'
import { readPclSnapshot } from '../src/core/pcl-import.ts'

const appData = process.env.APPDATA ?? ''
const snapshot = await readPclSnapshot({ appData, launcherDirs: process.argv.slice(2) })
console.log('PCL 来源：', snapshot.sources)
console.log('游戏目录：', snapshot.folders, '选中：', snapshot.selectedFolder, snapshot.selectedVersion)
console.log('账号：', snapshot.accounts.map((account) => `${account.type}:${account.username}${account.serverName ? `@${account.serverName}` : ''}`))
const javas = await detectJava(snapshot.javaPaths)
console.log('Java：', javas.map((java) => `${java.majorVersion} ${java.path}`))
for (const folder of snapshot.folders) {
  for (const item of await listInstances(folder.path)) {
    console.log(`  ${item.id} | MC ${item.minecraftVersion} | ${item.loader} ${item.loaderVersion ?? ''} | Java ${item.javaMajor} | 隔离 ${item.isolated} | mods ${item.modCount}${item.error ? ` | 错误 ${item.error.slice(0, 120)}` : ''}`)
  }
}
