import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { cleanEnv } from './env.mjs'
import { isolatedProcessEnv } from './isolated-home.mjs'

export async function seedBeuiDemo(cdp, box) {
  const pictures = await cdp.evaluate(`Array.from({ length: 3 }, (_, i) => {
    const canvas = document.createElement('canvas')
    canvas.width = 720; canvas.height = 450
    const g = canvas.getContext('2d')
    g.fillStyle = ['#e7eefa', '#101c2a', '#e9f2e8'][i]; g.fillRect(0, 0, 720, 450)
    g.fillStyle = ['#1c3049', '#eaf3ff', '#214b3c'][i]; g.font = 'bold 34px sans-serif'; g.fillText('Inkstone / ' + ['Version 1', 'Version 2', 'Alternate'][i], 48, 77)
    g.font = '17px sans-serif'; g.fillText('beUI interaction demo · local fixture', 48, 111)
    const colors = ['#508cef', '#2aca9e', '#efad5a']
    for (let col = 0; col < 9; col++) {
      const height = 48 + ((col * 17 + i * 29) % 90)
      g.fillStyle = colors[(col + i) % 3]; g.fillRect(50 + col * 70, 345 - height, 43, height)
    }
    g.fillStyle = ['#1c3049', '#eaf3ff', '#214b3c'][i]; g.fillRect(48, 349, 602, 2)
    return canvas.toDataURL('image/png').split(',')[1]
  })`)
  const artifactDir = join(box.dataDir, 'artifacts', 's-beui-demo')
  await mkdir(artifactDir, { recursive: true })
  const now = Date.now()
  const files = ['工作台预览-v1.png', '工作台预览-v2.png', '另一张示例图.png']
  const artifacts = await Promise.all(files.map(async (filename, i) => {
    const path = join(artifactDir, filename)
    const bytes = Buffer.from(pictures[i], 'base64')
    await writeFile(path, bytes)
    return { id: `beui-art-${i}`, sourceId: i === 2 ? 'beui-alt' : 'beui-cover', version: i === 1 ? 2 : 1, filename, path, mediaType: 'image/png', kind: 'image', bytes: bytes.length, createdAt: now + i, previewable: true, description: i === 1 ? '点开后选择「前后对照」' : undefined }
  }))
  await writeFile(join(artifactDir, 'manifest.json'), JSON.stringify(artifacts.map((artifact) => ({ messageId: 'beui-results', artifact }))))
  const projectDir = relative(box.runDir, box.project)
  if (!projectDir || projectDir.startsWith('..') || isAbsolute(projectDir)) throw new Error('Git 图片示例只允许使用隔离项目')
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: box.project, env: cleanEnv(isolatedProcessEnv(box.home)), encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error))
  }
  const gitImage = join(box.project, 'beui-compare.png')
  await writeFile(gitImage, Buffer.from(pictures[0], 'base64'))
  git('add', '--', 'beui-compare.png')
  git('-c', 'user.name=Inkstone Debug', '-c', 'user.email=debug@inkstone.invalid', 'commit', '-qm', 'fixture image before', '--', 'beui-compare.png')
  await writeFile(gitImage, Buffer.from(pictures[1], 'base64'))
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme:'dark', lang:'zh-CN', reduceMotion:false, rightPanelOpen:false, promptSuggestions:false }); window.__yanRightPanel.getState().setOpen(false)`)
  const sources = [
    { title: '工作台设计规范', url: 'https://design.example.invalid/spec', domain: 'design.example.invalid', snippet: '用于演示正文引用与来源对照。' },
    { title: '未在正文引用的候选来源', url: 'https://other.example.invalid/notes', domain: 'other.example.invalid', snippet: '不应出现在答复来源清单。' }
  ]
  const user = { id:'beui-user', role:'user', text:'演示：图片查看器、前后对照、引用清单、生成状态与成果库「更多」菜单。', timestamp:now - 5000 }
  const tools = { id:'beui-tools', role:'assistant', text:'', timestamp:now - 4000, toolCalls:[
    { id:'beui-read', name:'read', args:{ path:'preview.png' }, status:'ok', images:pictures.map((data) => ({ mimeType:'image/png', data })) },
    { id:'beui-search', name:'web_search', args:{ query:'工作台设计规范' }, status:'ok', details:{ search:{ action:'query', items:sources } } }
  ] }
  const answer = { id:'beui-results', role:'assistant', text:'图片可缩放和翻看；第二版点开后可对照。正文重复标注同一条[设计规范](https://design.example.invalid/spec)，答复下方只留一条[引用](https://design.example.invalid/spec)。成果库切到网格可看「更多」菜单。', timestamp:now - 3000, artifacts }
  const runUser = { id:'beui-image-user', role:'user', text:'演示图片生成的原位状态。', timestamp:now - 2000 }
  const image = { id:'beui-image', role:'assistant', text:'', timestamp:now - 1000, imageProgress:[{ id:'demo-img', stage:'generating', startedAt:now-1000, updatedAt:now }] }
  const apply = (messages) => cdp.evaluate(`(() => { const s=window.__yanStore.getState(); window.__yanStore.setState({ messages:${JSON.stringify(messages)}, session:{...s.session, isAgentRunning:false, isStreaming:false}, historyLoading:false, switchLoading:false }) })()`)
  const show = (stage) => {
    const result = { ...artifacts[2], id:'beui-image-result', sourceId:'beui-image-result' }
    const progress = { ...image.imageProgress[0], stage, ...(stage === 'done' ? { artifactId:result.id } : stage === 'error' ? { detail:'这是一条本地夹具失败回执' } : {}) }
    return apply([user, tools, answer, runUser, { ...image, imageProgress:[progress], ...(stage === 'done' ? { artifacts:[result] } : {}) }])
  }
  return { show }
}
