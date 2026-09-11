/**
 * 把 Maple Mono CN 字体复制到 renderer 的资源目录。
 *
 * 为什么需要这一步：字体全量 18.5MB，按 .gitignore 约定不入库
 * （见 .gitignore「字体全量文件」一节）。所以新克隆的仓库没有它，
 * @font-face 会静默回退成系统字体 —— 汉字格宽不再是 15.00px，
 * 整个等宽栅格就塌了（而且不报错，很难发现）。
 *
 * 用法： npm run font
 * 源：   docs/design/font-test/MapleMono-CN-Regular.ttf
 *
 * 发布前应改成 woff2 子集（cn-font-split，约 2–3MB），见 DESIGN.md §2.1。
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'docs/design/font-test/MapleMono-CN-Regular.ttf')
const DEST = join(root, 'src/renderer/src/assets/fonts/MapleMono-CN-Regular.ttf')

const exists = async (p) => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

if (!(await exists(SRC))) {
  console.error(`✗ 找不到字体源文件：${SRC}`)
  console.error('  字体获取方式见 docs/design/font-test/README.md')
  process.exit(1)
}

await mkdir(dirname(DEST), { recursive: true })
await copyFile(SRC, DEST)

const { size } = await stat(DEST)
console.log(`✓ 字体就位 ${(size / 1024 / 1024).toFixed(1)}MB → src/renderer/src/assets/fonts/`)
console.log('  预期效果：12.5px 下汉字格宽 15.00px（npm run probe 会验证）')
