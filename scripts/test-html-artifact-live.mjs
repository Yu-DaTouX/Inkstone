/** 隔离的真实 Electron / preload / IPC / 成果卡片链路；不复制凭证、不调用模型。 */
import './lib/stdio-guard.mjs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, copyFile, stat, rm, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'

const root = process.cwd()
const electron = createRequire(import.meta.url)('electron')
const temp = await mkdtemp(join(tmpdir(), 'yan-html-artifact-live-'))
const screenshots = resolve(process.env.YAN_HTML_SHOT_DIR || `.local-docs/evidence/html-artifact-preview-${Date.now()}`)
let requests = 0
const server = createServer((_req, res) => { requests++; res.end('this request should have been blocked') })
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const attackUrl = `http://127.0.0.1:${server.address().port}`
const probeSource = await readFile(join(root, 'scripts/probe/html-artifact.js'), 'utf8')

try {
  await mkdir(dirname(screenshots), { recursive: true })
  // 每次用新目录，保留既有截图与证据，不覆盖上次运行。
  await mkdir(screenshots)
  for (const [name, theme, size] of [['dark', 'dark', '1440x900'], ['light', 'light', '1440x900'], ['narrow', 'dark', '940x900']]) {
    const base = join(temp, name)
    const data = join(base, 'data')
    const artifacts = join(data, 'artifacts', 'fixture-session')
    const userData = join(base, 'electron')
    const pi = join(base, 'pi')
    const downloads = join(base, 'downloads')
    await Promise.all([artifacts, userData, pi, downloads].map((path) => mkdir(path, { recursive: true })))
    await writeFile(join(data, 'desktop.json'), JSON.stringify({ cwd: root, theme, locale: 'zh-CN', workspaceMode: 'coding', onboardingDone: true, remoteAccess: { enabled: false } }))
    await writeFile(join(pi, 'settings.json'), JSON.stringify({ enableMcp: false }))
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px sans-serif;padding:24px}button{padding:12px}</style></head><body><h1>消息内 HTML 预览</h1><p>内联脚本交互可用，宿主与网络保持隔离。</p><button id="counter">计数 0</button><!--${'完整文件测试 '.repeat(140000)}--><script>
      const send = (data) => parent.postMessage({htmlArtifactProbe:true,...data}, '*');
      let parentBlocked=false,storageBlocked=false,count=0;
      try{void parent.document.body}catch{parentBlocked=true}
      try{localStorage.setItem('test','1')}catch{storageBlocked=true}
      send({kind:'ready',hostBridge:typeof window.yan,node:typeof require,parentBlocked,storageBlocked,microphoneAllowed:document.permissionsPolicy?.allowsFeature('microphone')??document.featurePolicy?.allowsFeature('microphone')??false});
      fetch('${attackUrl}/fetch').then(()=>send({kind:'fetch-allowed'})).catch(()=>send({kind:'fetch-blocked'}));
      const image=new Image(); image.src='${attackUrl}/image';
      const child=document.createElement('iframe'); child.src='${attackUrl}/child'; document.body.append(child);
      document.querySelector('#counter').onclick=()=>{document.querySelector('#counter').textContent='计数 '+(++count);send({kind:'counter',count})};
      addEventListener('message',event=>{if(event.source!==parent)return;if(event.data?.htmlArtifactCommand==='increment')document.querySelector('#counter').click();if(event.data?.htmlArtifactCommand==='navigate')location.href='${attackUrl}/navigation'});
    </script></body></html>`
    const path = join(artifacts, 'preview.html')
    await writeFile(path, html)
    const fixture = { artifact: { id: 'html-test', filename: 'preview.html', path, mediaType: 'text/html', kind: 'code', previewable: true, bytes: Buffer.byteLength(html), createdAt: Date.now(), description: '完整文件、脚本交互与离线隔离验证' } }
    if (process.env.YAN_HTML_PREVIEW_FILE) {
      const archifyPath = join(artifacts, 'archify-report.html')
      const original = await readFile(resolve(process.env.YAN_HTML_PREVIEW_FILE), 'utf8')
      fixture.archifyInteraction = original.includes('id="btn-theme"') && original.includes('Archify')
      // 只在隔离复制件追加观察脚本；真实产物保持只读，不给生产预览加入消息桥接。
      const observe = fixture.archifyInteraction ? `<script>(()=>{const button=document.getElementById('btn-theme');const before=document.documentElement.getAttribute('data-theme');button.click();const themeChanged=document.documentElement.getAttribute('data-theme')!==before;if(document.documentElement.getAttribute('data-theme')!=='${theme}')button.click();parent.postMessage({htmlArtifactProbe:true,kind:'archify-interaction',themeChanged,svgReady:!!document.querySelector('svg'),theme:document.documentElement.getAttribute('data-theme')},'*')})()</script>` : ''
      await writeFile(archifyPath, original + observe)
      fixture.archify = { ...fixture.artifact, id: 'archify-test', filename: 'archify-report.html', path: archifyPath, bytes: (await stat(archifyPath)).size, description: '实际 Archify 产物：消息内网页渲染' }
    }
    const probe = join(base, 'probe.js')
    await writeFile(probe, `window.__HTML_ARTIFACT_FIXTURE__=${JSON.stringify(fixture)};\n${probeSource}`)
    const shot = join(screenshots, `html-artifact-${name}.png`)
    const env = {
      ...process.env,
      YAN_PI_DIR: pi, YAN_USER_DATA: userData, YAN_DATA_DIR: data, YAN_DOWNLOADS_DIR: downloads,
      YAN_PROBE: probe, YAN_PROBE_DELAY: '3500', YAN_PROBE_SHOT: shot, YAN_PROBE_SHOT_DELAY: '8000',
      YAN_PROBE_OUT: join(base, 'probe-result.txt'), YAN_WIN: size
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const result = await new Promise((resolveRun, reject) => {
      const child = spawn(electron, [join(root, 'out/main/index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let output = ''
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { output += data.toString() })
      const timer = setTimeout(() => { child.kill(); reject(new Error(`HTML live ${name} timeout\n${output}`)) }, 60000)
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('exit', (code) => { clearTimeout(timer); resolveRun({ code, output }) })
    })
    await writeFile(join(screenshots, `html-artifact-${name}.log`), result.output)
    const receipt = await readFile(join(base, 'probe-result.txt'), 'utf8').catch(() => '')
    console.log(`HTML live ${name}: exit=${result.code}\n${receipt}`)
    if (result.code !== 0 || !receipt || receipt.includes('✗')) throw new Error(`HTML live ${name} failed; see ${screenshots}`)
    const shots = (await readdir(screenshots)).filter((file) => file.startsWith(`html-artifact-${name}-`) && file.endsWith('.png')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (!shots.length) throw new Error(`HTML live ${name}: missing screenshot`)
    await copyFile(join(screenshots, shots.at(-1)), shot)
  }
  if (requests !== 0) throw new Error(`HTML preview leaked ${requests} requests to the loopback fixture`)
  console.log('HTML live: three actual windows passed; 0 requests reached the network fixture')
} finally {
  await new Promise((resolveClose) => server.close(resolveClose))
  await rm(temp, { recursive: true, force: true })
}
