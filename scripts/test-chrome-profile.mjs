/**
 * 本机 Chrome profile 同步的单元测试（纯文件系统 + 纯函数，不碰真实 Chrome 数据）。
 *
 * 为什么必须有：这段逻辑会去读用户真实 Chrome 的目录。一旦选择规则写错
 * （比如把 `Profile 1` 当成 `Default`、或跨平台路径拼错），轻则同步不到东西，
 * 重则读错 profile。用合成目录把「选哪个 profile / 拼哪个路径 / 失败怎么报」
 * 全部钉住，真实 profile 一个字节都不碰。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runChromeProfileTests(ok) {
  const {
    chromeUserDataRoot,
    pickProfileName,
    syncChromeProfile
  } = await import('../out/test/chrome-profile.mjs')

  /* ---- 1. 跨平台路径 ---- */
  console.log('\n--- 12. 本机 Chrome 路径 ---')
  const win = chromeUserDataRoot('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u')
  ok(win === join('C:\\Users\\u\\AppData\\Local', 'Google', 'Chrome', 'User Data'), 'Windows 路径正确', win)
  const mac = chromeUserDataRoot('darwin', {}, '/Users/u')
  ok(mac === join('/Users/u', 'Library', 'Application Support', 'Google', 'Chrome'), 'macOS 路径正确', mac)
  const linux = chromeUserDataRoot('linux', {}, '/home/u')
  ok(linux === join('/home/u', '.config', 'google-chrome'), 'Linux 路径正确', linux)
  const xdg = chromeUserDataRoot('linux', { XDG_CONFIG_HOME: '/home/u/.cfg' }, '/home/u')
  ok(xdg === join('/home/u/.cfg', 'google-chrome'), 'XDG_CONFIG_HOME 生效', xdg)

  /* ---- 2. 选哪个子 profile ---- */
  console.log('\n--- 13. 选择子 profile ---')
  ok(pickProfileName(['Default', 'Profile 1']) === 'Default', 'Default 优先', pickProfileName(['Default', 'Profile 1']))
  ok(pickProfileName(['Profile 1', 'Profile 2']) === 'Profile 1', '没有 Default 时取 Profile N', pickProfileName(['Profile 1', 'Profile 2']))
  ok(pickProfileName(['Guest Profile', 'System Profile']) === null, '只有非用户 profile 时返回 null')
  ok(pickProfileName(['Default'], { YAN_CHROME_PROFILE: 'Profile 3' }) === 'Default', 'override 不存在时回落 Default')
  ok(
    pickProfileName(['Default', 'Profile 3'], { YAN_CHROME_PROFILE: 'Profile 3' }) === 'Profile 3',
    'override 存在时优先',
    pickProfileName(['Default', 'Profile 3'], { YAN_CHROME_PROFILE: 'Profile 3' })
  )

  /* ---- 3. 同步：成功项 / 可选缺失 / 必需缺失 ---- */
  console.log('\n--- 14. 同步本机 profile（合成目录）---')
  const root = await mkdtemp(join(tmpdir(), 'yan-chrome-src-'))
  const target = await mkdtemp(join(tmpdir(), 'yan-chrome-dst-'))
  // 源：造出 History / Cookies / Local State / Local Storage；故意不造 Bookmarks
  await mkdir(join(root, 'Default', 'Network'), { recursive: true })
  await mkdir(join(root, 'Default', 'Local Storage', 'leveldb'), { recursive: true })
  await writeFile(join(root, 'Local State'), '{"os_crypt":{"encrypted_key":"x"}}')
  await writeFile(join(root, 'Default', 'History'), 'HISTORY')
  await writeFile(join(root, 'Default', 'Network', 'Cookies'), 'COOKIES')
  await writeFile(join(root, 'Default', 'Local Storage', 'leveldb', 'LOG'), 'LS')

  const report = syncChromeProfile(target, { root, name: 'Default', dir: join(root, 'Default') })
  ok(report.copied.includes('Local State'), 'Local State 已同步（cookie 解密密钥）')
  ok(report.copied.some((c) => c.endsWith('History')), 'History 已同步')
  ok(report.copied.some((c) => c.endsWith('Network/Cookies')), 'Cookies 已同步')
  ok(report.copied.some((c) => c.includes('Local Storage')), 'Local Storage 已同步')
  ok(existsSync(join(target, 'Local State')), '目标里确实有 Local State')
  ok(existsSync(join(target, 'Default', 'History')), '目标里确实有 History')
  ok(existsSync(join(target, 'Default', 'Network', 'Cookies')), '目标里确实有 Cookies')
  // Bookmarks 是可选项，缺了不该出现在 failed
  ok(!report.failed.some((f) => f.item.includes('Bookmarks')), '可选文件缺失不算失败')

  /* 必需项缺失要如实上报 */
  const root2 = await mkdtemp(join(tmpdir(), 'yan-chrome-src2-'))
  const target2 = await mkdtemp(join(tmpdir(), 'yan-chrome-dst2-'))
  await mkdir(join(root2, 'Default'), { recursive: true })
  await writeFile(join(root2, 'Default', 'History'), 'H') // 没有 Local State、没有 Cookies
  const report2 = syncChromeProfile(target2, { root: root2, name: 'Default', dir: join(root2, 'Default') })
  ok(report2.copied.some((c) => c.endsWith('History')), '缺其它项时 History 仍能同步')
  ok(report2.failed.some((f) => f.item === 'Local State'), '缺 Local State 上报为失败')
  ok(report2.failed.some((f) => f.item.endsWith('Network/Cookies')), '缺 Cookies 上报为失败')

  /* 目录当文件拷（覆盖 EBUSY 那条分支）：Cookie 路径实际是个目录 → 必须报失败而不是崩 */
  const root3 = await mkdtemp(join(tmpdir(), 'yan-chrome-src3-'))
  const target3 = await mkdtemp(join(tmpdir(), 'yan-chrome-dst3-'))
  await mkdir(join(root3, 'Default', 'Network', 'Cookies'), { recursive: true })
  await writeFile(join(root3, 'Local State'), 'LS')
  await writeFile(join(root3, 'Default', 'History'), 'H')
  const report3 = syncChromeProfile(target3, { root: root3, name: 'Default', dir: join(root3, 'Default') })
  ok(report3.failed.some((f) => f.item.endsWith('Network/Cookies')), 'Cookie 复制失败时逐项上报（不抛异常）')
  ok(report3.copied.some((c) => c.endsWith('History')), '单项失败不影响其它项')
  /*
   * 关键回归：Cookie 没拷到时，解密密钥 `Local State` **绝不能**单独拷过去 ——
   * 否则托管 profile 原有的 cookie 会因密钥变了而全部解不开。
   */
  ok(!report3.copied.includes('Local State'), 'Cookie 失败时 Local State 一并跳过（保护原有 cookie）')

  /* 非 Default 源 profile 也必须落到托管 profile 的 Default 目录，
   * 否则 Profile 3 用户导入后会得到一个空白的托管 profile。 */
  const root4 = await mkdtemp(join(tmpdir(), 'yan-chrome-src4-'))
  const target4 = await mkdtemp(join(tmpdir(), 'yan-chrome-dst4-'))
  await mkdir(join(root4, 'Profile 3'), { recursive: true })
  await writeFile(join(root4, 'Profile 3', 'History'), 'PROFILE 3 HISTORY')
  const report4 = syncChromeProfile(target4, { root: root4, name: 'Profile 3', dir: join(root4, 'Profile 3') })
  ok(report4.copied.includes('Profile 3/History'), 'Profile 3 源文件已记录为已同步')
  ok(existsSync(join(target4, 'Default', 'History')), 'Profile 3 内容映射到目标 Default')
  ok(!existsSync(join(target4, 'Profile 3', 'History')), '目标不会误建 Profile 3 目录')

  await rm(root, { recursive: true, force: true })
  await rm(root2, { recursive: true, force: true })
  await rm(root3, { recursive: true, force: true })
  await rm(target, { recursive: true, force: true })
  await rm(target2, { recursive: true, force: true })
  await rm(target3, { recursive: true, force: true })
  await rm(root4, { recursive: true, force: true })
  await rm(target4, { recursive: true, force: true })
}
