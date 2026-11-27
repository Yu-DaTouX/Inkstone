import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { root } from './env.mjs'

const fence = (lang, body) => '```' + lang + '\n' + (typeof body === 'string' ? body : JSON.stringify(body)) + '\n```'

const CHARTS = [
  ['bar', { type: 'bar', title: '冷启动耗时', subtitle: '越低越好', unit: 'ms', labels: ['Electron', 'Tauri', '原生'], series: [{ name: '耗时', values: [820, 310, 140] }], source: '本机实测 5 次取中位数' }],
  ['hbar', { type: 'hbar', title: '依赖体积', unit: 'MB', labels: ['@electron/rebuild', 'typescript', 'mermaid', 'react-dom'], series: [{ name: '体积', values: [18.4, 22.1, 9.6, 4.3] }], stats: [{ label: '合计', value: '54.4 MB' }, { label: '最大', value: 'typescript' }], source: 'du -sh node_modules/*' }],
  ['stacked', { type: 'stacked', title: '每周会话构成', unit: '次', labels: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'], series: [{ name: '桌面', values: [42, 48, 51, 47, 55, 60] }, { name: '手机', values: [12, 15, 19, 22, 24, 29] }, { name: '远程', values: [4, 6, 5, 8, 9, 11] }, { name: '子代理', values: [8, 10, 14, 13, 18, 21] }], source: '埋点报表 2026-10' }],
  ['line', { type: 'line', title: '周活跃用户', unit: '千', labels: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'], series: [{ name: '桌面', values: [12.1, 12.8, 13.5, 13.2, 14.6, 15.3] }, { name: '手机', values: [3.2, 3.9, 4.8, 5.6, 6.1, 7.0] }], source: '埋点报表 2026-10' }],
  ['line-close', { type: 'line', title: '三个版本的首字延迟', unit: 'ms', labels: ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月', '1 月', '2 月'], series: [{ name: '0.13', values: [612, 598, 605, 590, 584, 580, 577, 571, 566, 560, 552, 548, 545, 540] }, { name: '0.14', values: [598, 590, 588, 579, 570, 566, 560, 556, 551, 547, 543, 541, 539, 538] }, { name: '0.15', values: [530, 520, 515, 505, 498, 490, 482, 470, 465, 460, 455, 450, 446, 441] }], source: '性能看板（同一台机器）' }],
  ['area', { type: 'area', title: '月度 token 用量', unit: 'M', labels: ['5 月', '6 月', '7 月', '8 月', '9 月', '10 月'], series: [{ name: '用量', values: [18, 26, 31, 29, 44, 52] }], source: '用量统计页 2026-10' }],
  ['dumbbell', { type: 'dumbbell', title: '优化前后的构建耗时', unit: 's', labels: ['typecheck', 'build', 'test:unit', 'dist'], series: [{ name: '优化前', values: [41, 58, 132, 210] }, { name: '优化后', values: [28, 37, 96, 171] }], source: 'CI 日志 2026-10' }],
  ['diverging', { type: 'diverging', title: '各模块覆盖率相对目标', unit: 'pt', labels: ['main', 'renderer', 'shared', 'mobile'], series: [{ name: '差值', values: [6, -4, 12, -9] }], source: '覆盖率报告 2026-10', note: '目标 80%' }]
]

const STATS = [
  { items: [{ label: '构建耗时', value: '28 s', delta: '-33%', trend: 'down', good: 'down', spark: [42, 39, 35, 36, 31, 28] }, { label: '包体积', value: '96 MB', delta: '+2 MB', trend: 'up', good: 'down', spark: [88, 90, 91, 94, 94, 96] }, { label: '测试', value: '412', detail: '全部通过' }], source: 'CI 日志 2026-10' },
  { items: [{ label: '本月额度', value: '4.2 / 5', meter: { value: 4.2, max: 5 } }, { label: '磁盘', value: '466 GB', meter: { value: 466, max: 512 }, detail: '剩 46 GB' }, { label: '内存', value: '61 / 64 GB', meter: { value: 61, max: 64 }, detail: '接近上限' }, { label: '队列', value: '12', meter: { value: 12, max: 100 } }] }
]

const CARDS = [
  { title: '本地向量库', layout: 'grid', items: [{ title: 'SQLite + sqlite-vec', badge: '零依赖', description: '单文件，适合十万条以内。', meta: '暴力检索', recommended: true }, { title: 'LanceDB', badge: '列存', description: '磁盘索引，百万级仍快。', meta: '多一个原生依赖' }, { title: 'Qdrant', badge: '服务', description: '功能最全，需要单独进程。', meta: '部署成本高' }] },
  { title: '值得先读的三篇', items: [{ title: 'Attention Is All You Need', description: 'Transformer 的出处。', meta: '2017 · NeurIPS', links: [{ label: 'arXiv', url: 'https://arxiv.org/abs/1706.03762' }] }, { title: 'Scaling Laws for Neural Language Models', description: '参数、数据与算力的幂律。', meta: '2020 · OpenAI' }, { title: 'Chinchilla: Training Compute-Optimal Large Language Models', description: '同样算力下，更多数据、更小模型更划算。', meta: '2022 · DeepMind' }] }
]

const RECORD = { title: 'pi-web-access', subtitle: 'pi 插件 · npm', badge: '0.37.0', fields: [{ label: '发布者', value: 'nicobailon' }, { label: '周下载', value: '1.2k' }, { label: '许可', value: 'MIT' }, { label: '最近发布', value: '2026-10-28' }, { label: '依赖', value: '3 个' }], links: [{ label: 'npm', url: 'https://www.npmjs.com/package/pi-web-access' }], note: '只在 Node 18 以上测试过。' }

const FLOWS = [
  { join: 'plus', steps: [{ title: '网络跨区', detail: '+120ms' }, { title: '代理排队', detail: '+80ms' }, { title: '缓存未命中', detail: '+150ms' }], result: { tone: 'err', text: '首字延迟超过 600ms' } },
  { join: 'arrow', steps: [{ icon: 'file', title: '保存文件' }, { icon: 'terminal', title: '触发构建' }, { icon: 'check-circle', title: '热更新' }], result: { tone: 'ok', text: '约 0.4 秒看到改动' } }
]

const STEPS = { title: '事件循环', loop: true, steps: [{ title: '执行同步代码', body: '调用栈清空前不处理回调。' }, { title: '清空微任务', body: 'Promise 回调全部执行完。' }, { title: '取一个宏任务', body: '定时器、I/O 回调等。' }, { title: '渲染', body: '浏览器按需重排、重绘。' }] }

const MERMAID = [
  ['flowchart', `flowchart LR
  A[用户输入] --> B{需要工具?}
  B -- 是 --> C[调用工具]
  B -- 否 --> D[直接回答]
  C --> D`],
  ['sequence', `sequenceDiagram
  participant U as 用户
  participant R as 渲染端
  participant M as 主进程
  U->>R: 发送消息
  R->>M: IPC 请求
  M-->>R: 流式事件
  R-->>U: 显示回答`]
]

const GRID_WIDGET = String.raw`<style>.h{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;color:var(--text-dim);font-variant-numeric:tabular-nums}.h b{color:var(--text);font-weight:600}.lg{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;font-size:12px;color:var(--text-dim);font-variant-numeric:tabular-nums}.lg i{display:inline-block;width:9px;height:9px;margin-right:5px;vertical-align:-1px;border-radius:2px}canvas{display:block;width:100%;margin:8px 0 6px}.t{font:12px/1.5 var(--mono);color:var(--text-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.t span{color:var(--text-dim)}.n{font-size:11px;color:var(--text-mute);margin-top:4px}#pb{position:absolute;width:0;height:0;overflow:hidden}</style>
<span id="pb"></span>
<div class="h"><span>翻译 <b id="cnt">0/1000</b></span><span id="spd"></span><span id="eta"></span><span id="cst"></span></div>
<div class="lg"><span><i id="sq"></i>排队 <b id="lq">0</b></span><span><i id="sr"></i>在跑 <b id="lr">0</b></span><span><i id="sd"></i>完成 <b id="ld">0</b></span><span><i id="sf"></i>失败 <b id="lf">0</b></span></div>
<canvas id="cv"></canvas>
<div class="t" id="tick">等待第一段完成…</div>
<div class="n">示意，数据为模拟；悬停格子看文件名与状态</div>
<script>
const N=1000,CON=16,S=7,G=2,P=['When power is lost, the store must keep write order → 断电时，存储必须保持写入顺序','Each page is checksummed before commit → 每页在提交前先算校验和','The journal is replayed on startup → 启动时重放日志','Offline writes queue until the link returns → 离线写入排队，等连接恢复']
const st=new Uint8Array(N),t0=new Float64Array(N),du=new Float64Array(N);let nx=0,dn=0,fd=0,rn=0,cost=0,start=0,last=-1,lt=0,pal=null,pt=0
const cx=cv.getContext('2d');let cols=1,dpr=1
const rm=matchMedia('(prefers-reduced-motion: reduce)').matches
const nm=i=>'segments/'+String(i+1).padStart(4,'0')+'.txt'
function col(v,fb){pb.style.color='var('+v+','+fb+')';const c=getComputedStyle(pb).color;cx.fillStyle='#010203';cx.fillStyle=c;return cx.fillStyle==='#010203'?fb:cx.fillStyle}
function palette(){pal={q:col('--text-mute','#8a8a92'),r:col('--c1','#3b82f6'),d:col('--ok','#22c55e'),e:col('--err','#ef4444')};sq.style.border='1px solid '+pal.q;sr.style.background=pal.r;sd.style.background=pal.d;sf.style.background=pal.e}
function size(){dpr=devicePixelRatio||1;const w=cv.clientWidth||600;cols=Math.max(10,Math.floor((w+G)/(S+G)));const h=Math.ceil(N/cols)*(S+G);cv.style.height=h+'px';cv.width=w*dpr;cv.height=h*dpr}
function step(now){for(let i=0;i<nx;i++)if(st[i]===1&&now-t0[i]>du[i]){rn--;if(Math.random()<.03){st[i]=3;fd++}else{st[i]=2;dn++;cost+=.0013;last=i}}while(nx<N&&rn<CON){st[nx]=1;t0[nx]=now;du[nx]=900+Math.random()*3200;nx++;rn++}}
function draw(now){if(!pal||now-pt>1000){palette();pt=now}cx.setTransform(dpr,0,0,dpr,0,0);cx.clearRect(0,0,cv.width,cv.height);cx.lineWidth=1;for(let i=0;i<N;i++){const s=st[i],x=(i%cols)*(S+G),y=Math.floor(i/cols)*(S+G);if(s===0){cx.globalAlpha=.6;cx.strokeStyle=pal.q;cx.strokeRect(x+.5,y+.5,S-1,S-1);continue}cx.fillStyle=s===1?pal.r:s===2?pal.d:pal.e;cx.globalAlpha=s===1?(rm?1:.55+.45*Math.abs(Math.sin((now-t0[i])/260))):1;cx.fillRect(x,y,S,S)}cx.globalAlpha=1}
function head(now){const m=(now-start)/60000,rt=m>0?dn/m:0,left=N-dn-fd;cnt.textContent=dn+'/'+N;spd.textContent=rt?Math.round(rt)+' 段/分':'';const em=rt?left/rt:0;eta.textContent=rt&&left?'预计还要 '+Math.floor(em)+' 分 '+Math.round(em%1*60)+' 秒':'';cst.textContent='已花 $'+cost.toFixed(2);lq.textContent=N-nx;lr.textContent=rn;ld.textContent=dn;lf.textContent=fd;if(last>=0)tick.innerHTML='<span>'+nm(last)+'</span>  '+P[last%P.length]}
function loop(now){if(now-lt>80){step(now);draw(now);head(now);lt=now}if(dn+fd>=N){setTimeout(reset,3000);return}requestAnimationFrame(loop)}
function reset(){st.fill(0);nx=dn=fd=rn=0;cost=0;last=-1;start=performance.now();tick.textContent='等待第一段完成…';requestAnimationFrame(loop)}
cv.onmousemove=ev=>{const b=cv.getBoundingClientRect(),c=Math.floor((ev.clientX-b.left)/(S+G)),w=Math.floor((ev.clientY-b.top)/(S+G)),i=w*cols+c;if(c>=cols||i<0||i>=N){cv.title='';return}cv.title=nm(i)+' · '+['排队','在跑 '+((performance.now()-t0[i])/1000).toFixed(1)+' 秒','完成','失败：模拟的限流错误'][st[i]]}
addEventListener('resize',size);size();reset()
</script>`

const BROKEN = '{ "type": "bar", "title": "写错的图", "labels": ["a", "b"]\n  "series": [{ "name": "x", "values": [1, 2] }], "source": "故意漏掉逗号" }'

export function widgetExamples() {
  const text = readFileSync(join(root, 'resources', 'skills', 'visual-answer', 'widget-examples.md'), 'utf8')
  const out = []
  const re = /\n([^\n]+)\n\n```yan-widget\n([\s\S]*?)\n```/g
  let match
  while ((match = re.exec(text))) out.push({ name: match[1].split(/[：:]/)[0].trim(), html: match[2] })
  return out
}

export function galleryBlocks() {
  const blocks = []
  for (const [name, spec] of CHARTS) blocks.push({ id: `chart-${name}`, kind: 'chart', md: fence('yan-chart', spec) })
  STATS.forEach((spec, i) => blocks.push({ id: `stats-${i ? 'meter' : 'spark'}`, kind: 'stats', md: fence('yan-stats', spec) }))
  blocks.push({ id: 'stats-spark4', kind: 'stats', md: fence('yan-stats', { items: [{ label: '构建耗时', value: '28 s', delta: '-33%', trend: 'down', good: 'down', spark: [42, 39, 35, 36, 31, 28] }, { label: '包体积', value: '96 MB', delta: '+2 MB', trend: 'up', good: 'down', spark: [88, 90, 91, 94, 94, 96] }, { label: '冷启动', value: '1.4 s', delta: '-12%', trend: 'down', good: 'down', spark: [1.7, 1.6, 1.6, 1.5, 1.4] }, { label: '测试', value: '412', delta: '+18', trend: 'up', spark: [380, 388, 395, 401, 412] }], source: 'CI 日志 2026-10' }) })
  CARDS.forEach((spec, i) => blocks.push({ id: `cards-${i ? 'list' : 'grid'}`, kind: 'cards', md: fence('yan-cards', spec) }))
  blocks.push({ id: 'record', kind: 'record', md: fence('yan-record', RECORD) })
  FLOWS.forEach((spec) => blocks.push({ id: `flow-${spec.join}`, kind: 'flow', md: fence('yan-flow', spec) }))
  blocks.push({ id: 'steps-loop', kind: 'steps', md: fence('yan-steps', STEPS) })
  for (const [name, source] of MERMAID) blocks.push({ id: `mermaid-${name}`, kind: 'mermaid', md: fence('mermaid', source) })
  widgetExamples().forEach((example, i) => blocks.push({ id: `widget-${i + 1}`, label: example.name, kind: 'widget', md: fence('yan-widget', example.html) }))
  blocks.push({ id: 'widget-grid', label: '点阵动画（主会话原例）', kind: 'widget', md: fence('yan-widget', GRID_WIDGET) })
  blocks.push({ id: 'stats-yaml', label: '模型写成 YAML', kind: 'stats', md: ['```yan-stats', 'title: 墨尔本未来四天', 'items:', '  - label: 今天 11/27', '    value: 23.6° / 19.1°', '    hint: 中阵雨，98% 有雨', '  - label: 明天 11/28', '    value: 23.3° / 15.9°', '    hint: 雷雨，100% 有雨', '  - label: 11/29', '    value: 17.3° / 13.4°', '    hint: 毛毛雨，73%', '  - label: 11/30', '    value: 15.2° / 12.6°', '    hint: 小雨转凉，33%', '```'].join('\n') })
  blocks.push({ id: 'invalid-json', kind: 'invalid', md: fence('yan-chart', BROKEN) })
  return blocks
}

export function galleryMarkdown(only = null) {
  const parts = ['下面把每种可视化块各画一遍。\n']
  for (const block of galleryBlocks().filter((b) => !only || only.includes(b.id))) parts.push(`**${block.label ? `${block.id} · ${block.label}` : block.id}**\n\n${block.md}\n`)
  parts.push('以上是全部块型。\n')
  return parts.join('\n')
}
