/**
 * 生成 README 用的界面截图（Electron 渲染 + 注入假数据）。
 *
 * 为什么不用真 pi 进程：截图只要「界面长什么样」，真起 pi 会依赖模型额度、
 * 网络和本地会话目录，而且每次内容都不同（README 的图会一直漂）。
 * 注入的数据见 `scripts/shot-fixture.js`。
 *
 * 用法：
 *   npm run shots
 *
 * 输出（都在 docs/design/preview/）：
 *   ui-live.png            深色主界面（真实感会话 + 运行中的终端窗口）
 *   yan-app-light.png      浅色主题
 *   reasoning-window.png   推理窗口（展开）
 *   ui-settings.png        设置面板
 *
 * ⚠️ 两个必须保留的坑：
 *   ① 不能在顶层 `await app.whenReady()` —— Electron 的 ESM 加载器要等
 *      整个模块图求值完才发 ready，而 ready 又要等这个 await，直接死锁。
 *      必须包在 main() 里调用。
 *   ② 窗口必须 `show: true` —— 隐藏窗口只合成一次（注入后的首帧），
 *      之后的折叠/切主题/开设置都不再出帧，capturePage 会一直拿到旧画面，
 *      `invalidate()` 也救不回来。
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/*
 * 输出目录：默认写进 README 用的 docs/design/preview/。
 *
 * `YAN_SHOT_DIR` 是给「只想要一张基线图看看、不想碰仓库里那几张
 * 已发布的预览图」用的（那些图有用户自己的未提交修改）。
 * 调 UI 时先导到临时目录，对比完再决定要不要刷新正式的那几张。
 */
const outDir = process.env.YAN_SHOT_DIR
  ? resolve(process.env.YAN_SHOT_DIR)
  : join(root, 'docs/design/preview')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 注册几个只影响「截图好看程度」的 IPC。
 *
 * 截图不跑主进程，文件区/额度区拿不到数据会显示「读取目录失败」——
 * 在真实应用里这是对的，但放进 README 会让人误以为是 bug。
 * 这里只给这两块和连接状态返回静态数据，其余（会话/模型/提示词）由
 * `shot-fixture.js` 直接写进 store。
 */
function registerStubHandlers() {
  ipcMain.handle('yan:agentStatus', () => ({ state: 'ready', detail: '' }))
  ipcMain.handle('yan:listDir', (_e, rel) => ({
    path: rel || '',
    abs: 'C:/work/pi-desktop' + (rel ? '/' + rel : ''),
    entries: [
      { name: 'src', dir: true },
      { name: 'docs', dir: true },
      { name: 'scripts', dir: true },
      { name: 'resources', dir: true },
      { name: 'package.json', dir: false, size: 2966 },
      { name: 'README.md', dir: false, size: 23073 },
      { name: 'electron-builder.yml', dir: false, size: 2624 },
      { name: 'tsconfig.json', dir: false, size: 107 }
    ],
    skipped: ['node_modules', '.git'],
    truncated: false,
    rootName: 'pi-desktop'
  }))
  ipcMain.handle('yan:providerQuota', (_e, provider) => ({
    provider: provider || 'openai-codex',
    supported: true,
    remaining: 8.42,
    currency: 'USD',
    label: '余额',
    windows: [
      { id: '5h', label: '5 小时', used: 1.58, total: 10 },
      { id: 'week', label: '本周', used: 6.2, total: 30 }
    ],
    checkedAt: Date.now()
  }))
}

async function main() {
  registerStubHandlers()
  await app.whenReady()

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    frame: false,
    backgroundColor: '#0b0b0d',
    webPreferences: {
      preload: join(root, 'out/preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  await win.loadFile(join(root, 'out/renderer/index.html'))

  // 主题/语言/引导标记先落 localStorage，再重载（否则截的是默认态）
  await win.webContents.executeJavaScript(`
    try {
      localStorage.setItem('yan.theme', 'dark');
      localStorage.setItem('yan.lang', 'zh-CN');
      localStorage.setItem('yan.onboarded', '1');
      localStorage.setItem('yan.termSize', JSON.stringify({ h: 260, w: 0 }));
    } catch {}
  `)
  await win.webContents.reload()

  // 等字体真正就绪（Maple 栅格对齐），否则汉字会回退
  const cnWidth = await win.webContents.executeJavaScript(`
    document.fonts.ready.then(() => {
      const el = document.createElement('span');
      el.style.cssText = 'position:fixed;visibility:hidden;font:12.5px "Maple Mono CN"';
      el.textContent = '国';
      document.body.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    })
  `)

  const fixture = await readFile(join(root, 'scripts/shot-fixture.js'), 'utf8')
  const injected = await win.webContents.executeJavaScript(fixture)
  if (injected !== 'ok') throw new Error('fixture 注入失败: ' + injected)
  await wait(700)

  const shot = async (name) => {
    // 再等两帧：确保 React 的这次变更已经画出来
    await win.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
    )
    await wait(180)
    const outPath = join(outDir, name)
    await mkdir(dirname(outPath), { recursive: true })
    const img = await win.webContents.capturePage()
    await writeFile(outPath, img.toPNG())
    console.log('✓', name)
  }

  /** 收起所有推理窗口（主图要的是对话正文 + 终端） */
  const collapseReasoning = async () => {
    await win.webContents.executeJavaScript(`
      document.querySelectorAll('[data-testid="reasoning-toggle"]').forEach((b) => {
        if (b.getAttribute('aria-expanded') === 'true') b.click();
      });
    `)
    await wait(300)
  }

  // 1) 深色主界面
  await collapseReasoning()
  await wait(300)
  await shot('ui-live.png')

  // 2) 浅色主题（令牌直接切，不用重载）
  await win.webContents.executeJavaScript("document.documentElement.dataset.theme = 'light'")
  await wait(350)
  await shot('yan-app-light.png')
  await win.webContents.executeJavaScript("document.documentElement.dataset.theme = 'dark'")
  await wait(250)

  // 3) 推理窗口（展开最后一段推理）
  await win.webContents.executeJavaScript(`
    const toggles = document.querySelectorAll('[data-testid="reasoning-toggle"]');
    const last = toggles[toggles.length - 1] || toggles[0];
    if (last && last.getAttribute('aria-expanded') !== 'true') last.click();
  `)
  await wait(350)
  await shot('reasoning-window.png')
  await collapseReasoning()
  await wait(250)

  // 4) 设置面板
  await win.webContents.executeJavaScript(
    "window.__yanStore.getState().openSettings('appearance')"
  )
  await wait(450)
  await shot('ui-settings.png')

  const ok = Math.abs(cnWidth - 15) < 0.01
  console.log(`  汉字格宽 = ${Number(cnWidth).toFixed(2)}px  ${ok ? '(Maple 已生效)' : '⚠️ 字体未生效'}`)
  app.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('✗ 截图失败：', err)
  app.exit(2)
})
