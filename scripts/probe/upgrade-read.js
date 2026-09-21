/**
 * 升级读取验证的探针（RELEASING「用真实数据的备份副本验证升级」）。
 *
 * ── 它与 `packaged.js` 的区别 ──
 * `packaged.js` 断言的是**空沙箱**里的行为（含 `kn-packaged` fixture 条目），
 * 所以拿真实用户数据的副本来跑它一定会红 —— 那验的是另一件事。
 * 这一条只做「**读回来什么**」：设置、项目、localStorage、凭证与连接态，
 * 并把这些值打成一行 JSON 交给 Node 侧比对（Node 侧才知道副本里原本写的是什么）。
 *
 * 判据纪律：**只读**，不写设置、不改凭证、不伪造登录态
 *（`profile.signedIn` 必须如实反映副本里的值）。
 */
;(async () => {
  const out = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  for (let i = 0; i < 80 && !store; i += 1) await sleep(250)

  const summary = { ok: false }

  try {
    /* 连接态：凭证可用时打包实例能真的把内置 pi 拉起来 */
    let conn = store?.getState?.().conn ?? null
    for (let i = 0; i < 60 && conn !== 'ready'; i += 1) {
      await sleep(500)
      conn = store?.getState?.().conn ?? conn
    }
    summary.conn = conn

    const settings = await window.yan.getSettings().catch(() => null)
    summary.settings = settings
      ? {
          cwd: settings.cwd ?? null,
          lang: settings.lang ?? null,
          theme: settings.theme ?? null,
          projects: Array.isArray(settings.projects) ? settings.projects.length : null,
          profile: settings.profile
            ? { name: settings.profile.name ?? null, signedIn: settings.profile.signedIn === true, avatarValue: settings.profile.avatarValue ?? null }
            : null
        }
      : null

    const auth = await window.yan.authFileInfo().catch(() => null)
    summary.auth = auth ? { exists: auth.exists === true, count: auth.count ?? 0 } : null

    const info = await window.yan.piInfo().catch(() => null)
    summary.pi = info ? { version: info.version ?? null, bundled: /pi-runtime[\\/]dist[\\/]bundle[\\/]cli\.js$/i.test(String(info.bin ?? '')) } : null

    /* localStorage 是 Electron userData 里的东西 —— 「升上来还认账」要看它 */
    let rawTheme = null
    let rawOnboarded = null
    try {
      rawTheme = window.localStorage.getItem('yan.theme')
      rawOnboarded = window.localStorage.getItem('yan.onboarded')
    } catch {
      /* 读不到就如实 null */
    }
    summary.local = { theme: rawTheme, onboarded: rawOnboarded }

    summary.ok = summary.conn === 'ready' && !!summary.settings
  } catch (error) {
    summary.error = error?.message ?? String(error)
  }

  out.push('UPGRADE-READ ' + JSON.stringify(summary))
  return out.join('\n')
})()
