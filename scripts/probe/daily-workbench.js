/** Current-conversation map, real isolated session logs; no model calls. */
;(async()=>{
const out=[],store=window.__yanStore,sleep=ms=>new Promise(r=>setTimeout(r,ms)),q=s=>document.querySelector(s),qa=s=>[...document.querySelectorAll(s)];
const ok=(value,label)=>out.push(`  ${value?'✓':'✗'} ${label}`);
const wait=async fn=>{for(let i=0;i<80;i++){if(fn())return true;await sleep(100)}return false};
try {
await wait(()=>store.getState().settings&&store.getState().sessions.length);
await store.getState().setWorkspaceMode('daily');await sleep(300);
const sessions=store.getState().sessions,parent=sessions.find(s=>s.path.includes('yan-family-parent')),plain=sessions.find(s=>s.path.includes('yan-plain-fixture'));
ok(!!parent&&!!plain,'隔离目录中存在家族会话与独立会话');if(!parent||!plain)return out.join('\n');
await store.getState().switchSession(parent.path);await wait(()=>q('[data-testid=view-map]'));q('[data-testid=view-map]')?.click();
await wait(()=>qa('[data-testid=map-turn-card]').length>0);
ok(!!q('[data-testid=session-map]'),'会话地图打开');
const family=new Set([parent.path,...sessions.filter(s=>s.parentSession===parent.path).map(s=>s.path)]);
ok(qa('[data-testid=map-turn-card]').every(c=>family.has(c.dataset.path)),'地图只展示当前会话家族');
ok(!qa('[data-testid=map-turn-card]').some(c=>c.dataset.path===plain.path),'独立会话不会混入当前地图');
const parentCards=()=>qa('[data-testid=map-turn-card]').filter(c=>c.dataset.path===parent.path);
ok(parentCards().length===1,'父会话按实际日志呈现一轮问答');
const children=sessions.filter(s=>s.parentSession===parent.path);
await wait(()=>children.every(child=>qa('[data-testid=map-turn-card]').some(c=>c.dataset.path===child.path)));
ok(children.length===2&&children.every(child=>qa('[data-testid=map-turn-card]').filter(c=>c.dataset.path===child.path).length===1),'分支各显示新问答，不重复继承的父轮次');
const first=parentCards()[0];first?.querySelector('.conversation-map-summary')?.click();await sleep(180);
ok(!!q('[data-testid=map-preview]'),'选择轮次可查看完整消息');
ok(!!q('[data-testid=map-preview-fork]'),'详情中有从此轮分叉入口');
window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await sleep(180);
ok(!q('[data-testid=map-preview]')&&!!q('[data-testid=session-map]'),'Esc 先关闭详情并保留地图');
await store.getState().switchSession(plain.path);await wait(()=>qa('[data-testid=map-turn-card]').some(c=>c.dataset.path===plain.path));
ok(qa('[data-testid=map-turn-card]').every(c=>c.dataset.path===plain.path),'切换独立会话后地图切换到该会话');
ok(qa('[data-testid=map-turn-card]').length===10,'20 条消息按真实日志投影为 10 轮');
const plainCards=()=>qa('[data-testid=map-turn-card]');
plainCards()[0]?.querySelector('.conversation-map-actions button:last-child')?.click();await sleep(180);
ok(plainCards().length===1,'折叠隐藏其后九轮，首卡不堆叠');
plainCards()[0]?.querySelector('.conversation-map-actions button:last-child')?.click();await sleep(180);
ok(plainCards().length===10,'展开恢复十轮问答');
const cards=qa('[data-testid=map-turn-card]');ok(cards.every((c,i)=>i===0||cards[i-1].getBoundingClientRect().bottom<=c.getBoundingClientRect().top),'问答卡片不重叠');
window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await sleep(180);ok(!q('[data-testid=session-map]'),'Esc 退出地图');
await store.getState().setWorkspaceMode('coding');await sleep(180);ok(!q('[data-testid=view-map]'),'编码模式没有地图入口');
}catch(error){out.push('  ✗ 探针异常：'+String(error))}
return out.join('\n')
})()
