import './lib/test-isolate.mjs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { createTrayResources, createTaskbarThrottle } = await compile('src/main/attention/index.ts')
  const root = await mkdtemp(join(tmpdir(), 'yan-tray-resources-'))
  try {
    const appDir = join(root, 'app')
    const moduleDir = join(root, 'out', 'main', 'chunk')
    const fallbackBuild = join(root, 'out', 'build')
    await mkdir(join(appDir, 'build'), { recursive: true })
    await mkdir(moduleDir, { recursive: true })
    const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    let dark = false
    const warnings = []
    const make = () =>
      createTrayResources({
        appPath: () => appDir,
        moduleDir,
        darkSystem: () => dark,
        createImage: (path) => ({ path: path.replace(/\\/g, '/') }),
        emptyImage: () => ({ empty: true }),
        onWarn: (message) => warnings.push(message)
      })
    const tray = make()
    const tail = (image) => image.path?.split('/').slice(-3).join('/')

    ok(tray.iconPath() === undefined, '没有图标文件时图标路径为空')
    ok(tray.image().empty === true, '没有托盘图与图标时退回空图')
    await writeFile(join(appDir, 'build', iconFile), 'x')
    ok(tray.iconPath() === join(appDir, 'build', iconFile), '图标按平台从应用目录 build 找')
    ok(tail(tray.image()) === `app/build/${iconFile}`, '没有托盘图时退回应用图标')

    await mkdir(join(fallbackBuild, 'tray'), { recursive: true })
    await writeFile(join(fallbackBuild, 'tray', 'tray-on-light.png'), 'x')
    await writeFile(join(fallbackBuild, 'tray', 'tray-on-dark.png'), 'x')
    ok(tray.theme() === 'on-light' && tail(tray.image()) === 'build/tray/tray-on-light.png', '浅色系统用 on-light 托盘图，次选模块目录上两级的 build')
    dark = true
    ok(tray.theme() === 'on-dark' && tail(tray.image()) === 'build/tray/tray-on-dark.png', '深色系统按调用时主题取 on-dark')
    await mkdir(join(appDir, 'build', 'tray'), { recursive: true })
    await writeFile(join(appDir, 'build', 'tray', 'tray-on-dark.png'), 'x')
    ok(tray.image().path.endsWith('app/build/tray/tray-on-dark.png'), '应用目录的托盘图优先')

    ok(tray.assets('running', 'on-dark') === undefined, '加载素材前没有动画帧')
    tray.ensureAssets()
    ok(warnings.length === 1 && warnings[0].includes('manifest.json'), '缺 manifest 时只发一条警告')

    const manifest = {
      version: 1,
      timelines: { running: { frames: [{ durationMs: 80 }] }, waiting: { frames: [{ durationMs: 90 }] } },
      themes: Object.fromEntries(['on-light', 'on-dark'].map((theme) => [theme, {
        static: { idle: `${theme}-idle.png`, running: `${theme}-run.png`, waiting: `${theme}-wait.png` },
        running: [`${theme}-r0.png`],
        waiting: [`${theme}-w0.png`]
      }]))
    }
    await writeFile(join(fallbackBuild, 'tray', 'manifest.json'), JSON.stringify(manifest))
    tray.ensureAssets()
    const running = tray.assets('running', 'on-dark')
    ok(running?.frames.length === 1 && running.frames[0].durationMs === 80 && running.frames[0].image.path.endsWith('build/tray/on-dark-r0.png'), '再次调用会重新加载，素材目录沿用首次计算的候选')
    ok(tray.assets('idle', 'on-light')?.static.path.endsWith('on-light-idle.png'), '静态帧按主题取')

    const fresh = make()
    await writeFile(join(appDir, 'build', 'tray', 'manifest.json'), '{ broken')
    fresh.ensureAssets()
    ok(fresh.assets('running', 'on-dark') === undefined && warnings.at(-1).includes('manifest'), '应用目录 manifest 优先，坏了就不退到次选目录')

    const wait = (ms) => new Promise((done) => setTimeout(done, ms))
    const calls = []
    const refresh = createTaskbarThrottle((force) => calls.push(force), 60)
    refresh()
    ok(calls.length === 1 && calls[0] === false, '首次刷新立即执行')
    refresh()
    refresh()
    ok(calls.length === 1, '间隔内的刷新合并')
    refresh(true)
    ok(calls.length === 2 && calls[1] === true, '强制刷新立即执行')
    refresh()
    await wait(100)
    ok(calls.length === 3 && calls[2] === false, '间隔到后补一次非强制刷新')
    refresh()
    refresh(true)
    await wait(100)
    ok(calls.length === 4 && calls[3] === true, '强制刷新清掉挂起的补刷')
    await wait(10)
    refresh()
    ok(calls.length === 5, '过了间隔再刷新立即执行')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
