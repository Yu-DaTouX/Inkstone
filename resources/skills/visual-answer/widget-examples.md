# yan-widget 范例

六种写法可以直接改着用，规则见同目录 `SKILL.md` 的 yan-widget 一节。

参数计算器：拖动一个量，看另一个量怎么变。

```yan-widget
<style>.row{display:flex;gap:12px;align-items:center}.row input{flex:1}.out{display:flex;gap:24px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)}.out b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.out span{color:var(--text-mute);font-size:12px}</style>
<label class="row">缓存命中率 <input id="hit" type="range" min="0" max="100" value="70"> <span id="hv">70%</span></label>
<div class="out"><div><b id="cost">0.37×</b><span>每轮相对成本</span></div><div><b id="save">63%</b><span>节省</span></div></div>
<script>const h=document.getElementById('hit');function u(){const p=+h.value/100,c=1-p*0.9;hv.textContent=h.value+'%';cost.textContent=c.toFixed(2)+'×';save.textContent=Math.round((1-c)*100)+'%'}h.oninput=u;u()</script>
```

方案切换：同一组指标，点不同方案看差别。

```yan-widget
<style>.tabs{display:flex;gap:6px}.tabs button[aria-pressed=true]{background:var(--text);color:var(--bg);border-color:var(--text)}.m{display:grid;grid-template-columns:72px 1fr 48px;gap:6px 10px;align-items:center;margin-top:12px}.bar{height:8px;border-radius:2px;background:var(--c1)}.v{text-align:right;font-variant-numeric:tabular-nums;color:var(--text-dim)}</style>
<div class="tabs" id="t"></div><div class="m" id="m"></div>
<script>const D={直连:{延迟:420,成本:30,稳定:90},经代理:{延迟:610,成本:34,稳定:97}},MAX={延迟:800,成本:50,稳定:100};let cur='直连';function r(){t.innerHTML=Object.keys(D).map(k=>`<button aria-pressed=${k===cur}>${k}</button>`).join('');[...t.children].forEach(b=>b.onclick=()=>{cur=b.textContent;r()});m.innerHTML=Object.entries(D[cur]).map(([k,v])=>`<span>${k}</span><div class="bar" style="width:${v/MAX[k]*100}%"></div><span class="v">${v}</span>`).join('')}r()</script>
```

时间轴：横向刻度上标出几个事件，点击看说明。

```yan-widget
<style>svg{display:block;width:100%;height:56px}circle{cursor:pointer}#d{margin:4px 0 0;color:var(--text-dim)}</style>
<svg viewBox="0 0 600 56"><line x1="10" y1="20" x2="590" y2="20" stroke="var(--border-strong)"/><g id="g"></g></svg><p id="d">点一个节点</p>
<script>const E=[[0,'2017','Transformer 提出'],[0.35,'2020','缩放定律'],[0.65,'2022','指令微调普及'],[1,'2025','长上下文与工具调用']];g.innerHTML=E.map(([x,y],i)=>`<circle cx="${10+x*580}" cy="20" r="6" fill="var(--c${i+1})" data-i="${i}"/><text x="${10+x*580}" y="48" font-size="12" fill="var(--text-mute)" text-anchor="${x===0?'start':x===1?'end':'middle'}">${y}</text>`).join('');g.onclick=e=>{const i=e.target.dataset.i;if(i)d.textContent=E[i][1]+'：'+E[i][2]}</script>
```

机制图：几个部件加连线，点按钮让过程走一遍。

```yan-widget
<style>svg{display:block;width:100%;height:120px}.box{fill:none;stroke:var(--border-strong)}.lab{font-size:13px;fill:var(--text);text-anchor:middle}.dot{fill:var(--accent)}</style>
<svg viewBox="0 0 600 120"><rect class="box" x="10" y="40" width="120" height="40" rx="6"/><text class="lab" x="70" y="65">客户端</text><rect class="box" x="240" y="40" width="120" height="40" rx="6"/><text class="lab" x="300" y="65">代理</text><rect class="box" x="470" y="40" width="120" height="40" rx="6"/><text class="lab" x="530" y="65">模型</text><line x1="130" y1="60" x2="240" y2="60" stroke="var(--border-strong)"/><line x1="360" y1="60" x2="470" y2="60" stroke="var(--border-strong)"/><circle id="p" class="dot" cx="130" cy="60" r="5" opacity="0"/></svg>
<button id="go">发送一次请求</button>
<script>go.onclick=()=>{p.setAttribute('opacity',1);p.animate([{transform:'translateX(0)'},{transform:'translateX(340px)'}],{duration:1200,easing:'ease-in-out'}).onfinish=()=>p.setAttribute('opacity',0)}</script>
```

前后对比：同一段内容改前、改后切换着看。

```yan-widget
<style>.sw{display:flex;gap:6px;margin-bottom:8px}.sw button[aria-pressed=true]{background:var(--text);color:var(--bg);border-color:var(--text)}pre{margin:0;padding:12px 16px;border-radius:var(--radius);background:var(--surface-2);font:12px/1.6 var(--mono);white-space:pre-wrap}</style>
<div class="sw"><button aria-pressed="true" data-k="a">改前</button><button aria-pressed="false" data-k="b">改后</button></div><pre id="c"></pre>
<script>const T={a:'for (const f of files) {\n  await upload(f)\n}',b:'await Promise.all(files.map(upload))'};const s=document.querySelector('.sw');function show(k){c.textContent=T[k];[...s.children].forEach(b=>b.setAttribute('aria-pressed',b.dataset.k===k))}s.onclick=e=>{if(e.target.dataset.k)show(e.target.dataset.k)};show('a')</script>
```

状态点阵：几百个任务各占一格，颜色加形状表示状态（空心排队、实心在跑/完成、叉号失败），悬停看是哪一个。

```yan-widget
<style>canvas{display:block;width:100%;margin-top:8px}.lg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--text-dim);font-variant-numeric:tabular-nums}.lg i{display:inline-block;box-sizing:border-box;width:8px;height:8px;margin-right:4px;border-radius:2px;font-style:normal;line-height:8px;text-align:center}</style>
<div class="lg" id="lg"></div><canvas id="cv"></canvas>
<script>const N=400,S=8,G=2,K=[['排队','--text-mute'],['在跑','--c1'],['完成','--ok'],['失败','--err']],st=Array.from({length:N},(_,i)=>i<250?2:i<262?3:i<290?1:0);let cols=1
const v=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim()
lg.innerHTML=K.map(([t,c],k)=>`<span><i style="${k?k<3?'background:var('+c+')':'color:var('+c+')':'border:1px solid var('+c+')'}">${k===3?'×':''}</i>${t} ${st.filter(s=>s===k).length}</span>`).join('')
function draw(){const w=cv.clientWidth,d=devicePixelRatio||1,c=K.map(k=>v(k[1]));cols=Math.max(1,Math.floor((w+G)/(S+G)));const h=Math.ceil(N/cols)*(S+G);cv.style.height=h+'px';cv.width=w*d;cv.height=h*d;const x=cv.getContext('2d');x.scale(d,d);x.lineWidth=1.5;st.forEach((s,i)=>{const a=i%cols*(S+G),b=Math.floor(i/cols)*(S+G);x.fillStyle=x.strokeStyle=c[s];if(s===0)x.strokeRect(a+.75,b+.75,S-1.5,S-1.5);else if(s===3){x.beginPath();x.moveTo(a+1,b+1);x.lineTo(a+S-1,b+S-1);x.moveTo(a+S-1,b+1);x.lineTo(a+1,b+S-1);x.stroke()}else x.fillRect(a,b,S,S)})}
cv.onmousemove=e=>{const b=cv.getBoundingClientRect(),c=Math.floor((e.clientX-b.left)/(S+G)),i=Math.floor((e.clientY-b.top)/(S+G))*cols+c;cv.title=c<cols&&i>=0&&i<N?'#'+(i+1)+' '+K[st[i]][0]:''}
draw();addEventListener('resize',draw);new MutationObserver(draw).observe(document.documentElement,{attributes:true})</script>
```
