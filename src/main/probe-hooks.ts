import { app, type BrowserWindow } from 'electron'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function armProbeShots(win: BrowserWindow): void {
  const shotPath = process.env.YAN_PROBE_SHOT
  if (process.env.YAN_PROBE && shotPath) {
    const parsedShotDelay = Number(process.env.YAN_PROBE_SHOT_DELAY ?? 20_000)
    const shotDelay = Number.isFinite(parsedShotDelay) && parsedShotDelay >= 0 ? parsedShotDelay : 20_000
    const shotLog = (m: string): void => {
      void appendFile(`${shotPath}.log`, `${new Date().toISOString()} ${m}\n`).catch(() => {})
    }
    shotLog(`armed delay=${shotDelay} path=${shotPath}`)
    let shotIndex = 0
    const shoot = (): void => {
      if (!win || win.isDestroyed()) return
      if (!win.isVisible()) win.showInactive()
      const target = shotPath.replace(/\.png$/i, `-${++shotIndex}.png`)
      void win.webContents
        .capturePage()
        .then((img) => writeFile(target, img.toPNG()))
        .then(() => shotLog(`saved ${target}`))
        .catch((e) => shotLog(`failed: ${e?.message ?? String(e)}`))
    }
    setTimeout(() => {
      shotLog('burst start')
      shoot()
      const timer = setInterval(() => {
        if (!win || win.isDestroyed()) {
          clearInterval(timer)
          shotLog('burst stop')
          return
        }
        shoot()
      }, Number(process.env.YAN_PROBE_SHOT_INTERVAL ?? 2000))
    }, shotDelay)
  }
}

export function armProbeRun(win: BrowserWindow, shutdown: () => Promise<void>): void {
  const probeFile = process.env.YAN_PROBE
  if (probeFile) {
    const delay = Number(process.env.YAN_PROBE_DELAY ?? 9000)
    win.once('ready-to-show', () => {
      setTimeout(() => {
        void (async () => {
          try {
            const src = await readFile(probeFile, 'utf8')
            const helper = await readFile(join(dirname(probeFile), 'workspace-helper.js'), 'utf8').catch(() => '')
            if (helper) await win.webContents.executeJavaScript(helper)
            const mouse = process.env.YAN_PROBE_MOUSE
            if (mouse) {
              const [mx, my] = mouse.split(',').map(Number)
              win.webContents.sendInputEvent({ type: 'mouseMove', x: mx, y: my })
              await new Promise((r) => setTimeout(r, 700))
            }

            const keys = process.env.YAN_PROBE_KEYS
            let keyTask: Promise<void> | null = null
            if (keys) {
              keyTask = (async () => {
                const delay = Number(process.env.YAN_PROBE_KEYS_DELAY) || 1800
                await new Promise((r) => setTimeout(r, delay))
                for (const combo of keys.split(',').map((s) => s.trim()).filter(Boolean)) {
                  const parts = combo.toLowerCase().split('+')
                  const key = parts.pop() ?? ''
                  const mods = new Set(parts)

                  const keyCode =
                    key === 'tab' ? 'Tab' : key.length === 1 ? key.toUpperCase() : key
                  const modifiers: Electron.InputEvent['modifiers'] = []
                  if (mods.has('ctrl')) modifiers.push('control')
                  if (mods.has('shift')) modifiers.push('shift')
                  if (mods.has('alt')) modifiers.push('alt')
                  if (mods.has('meta')) modifiers.push('meta')

                  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
                  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
                  await new Promise((r) => setTimeout(r, 1600))
                }
              })()
            }

            const result = await win.webContents.executeJavaScript(src, true)
            if (keyTask) await keyTask.catch(() => undefined)
            const body = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            console.log('---PROBE-START---')
            console.log(body)
            console.log('---PROBE-END---')
            if (process.env.YAN_PROBE_OUT) {
              await writeFile(
                process.env.YAN_PROBE_OUT,
                `${body}\n`,
                'utf8'
              ).catch(() => undefined)
            }
          } catch (e) {
            console.error('[probe] 失败', e)
            if (process.env.YAN_PROBE_DEBUG_PORT) return
          }
          await shutdown()
          app.exit(0)
        })()
      }, delay)
    })
  }
}
