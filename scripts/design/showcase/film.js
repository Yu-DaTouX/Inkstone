/* Deterministic Canvas film. All movement derives from a single time value. */
const canvas = document.getElementById('film'), c = canvas.getContext('2d');
const W=1920,H=1080,DURATION=48;
const dark={bg:'#151515',panel:'#1b1b1a',raised:'#222221',fg:'#ecece8',dim:'#b4b4ac',mute:'#777770',line:'#363633',accent:'#93a4f4',ok:'#91b69a'};
const light={bg:'#fcfcfa',panel:'#f3f3f0',raised:'#ffffff',fg:'#252522',dim:'#66665f',mute:'#88887f',line:'#deded7',accent:'#5264c8',ok:'#427650'};
let P=dark;
const clamp=x=>Math.max(0,Math.min(1,x)), ease=x=>1-Math.pow(1-clamp(x),3);
function rect(x,y,w,h,color,r=0){c.fillStyle=color;c.beginPath();c.roundRect(x,y,w,h,r);c.fill()}
function line(x,y,x2,y2,color=P.line,width=1){c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(x,y);c.lineTo(x2,y2);c.stroke()}
function text(s,x,y,size=26,color=P.fg,weight=400,font='"Segoe UI","Microsoft YaHei UI",sans-serif'){c.font=`${weight} ${size}px ${font}`;c.fillStyle=color;c.textBaseline='top';c.fillText(s,x,y)}
function mono(s,x,y,size=20,color=P.dim){text(s,x,y,size,color,400,'Consolas,"Microsoft YaHei UI",monospace')}
function center(s,y,size=64,color=P.fg,weight=400){c.font=`${weight} ${size}px "Segoe UI","Microsoft YaHei UI",sans-serif`;text(s,(W-c.measureText(s).width)/2,y,size,color,weight)}
function group(alpha,fn,dx=0,dy=0){c.save();c.globalAlpha*=clamp(alpha);c.translate(dx,dy);fn();c.restore()}
function enter(t,delay,fn,dy=22){const q=ease((t-delay)/.9);group(q,fn,0,(1-q)*dy)}
function logo(x,y,size,progress=1){c.save();c.translate(x,y);c.scale(size/100,size/100);c.lineWidth=6;c.lineJoin='round';c.strokeStyle=P.fg;c.setLineDash([260*clamp(progress),300]);c.stroke(new Path2D('M70 22H25Q22 22 22 25V75Q22 78 25 78H75Q78 78 78 75V53'));c.setLineDash([]);c.lineJoin='miter';c.lineCap='square';c.strokeStyle=P.accent;c.globalAlpha*=clamp((progress-.45)*2);c.stroke(new Path2D('M36 40L47 50L36 60 M57 62H69'));c.restore()}
function chrome(n,label){logo(67,43,58);mono('INKSTONE / 砚',137,62,20);mono(`0${n}   /   ${label}`,1492,62,18);line(80,116,1840,116);mono('GIVE IDEAS FORM.',80,1002,16,P.mute);mono('设计演示 · 合成内容',855,1002,16,P.mute);mono('DESIGN FILM   /   2026',1580,1002,16,P.mute)}
function title(kicker,headline,sub,t){enter(t,0,()=>mono(kicker,120,175,20,P.accent));enter(t,.15,()=>text(headline,116,222,62,P.fg,600));enter(t,.4,()=>text(sub,120,311,25,P.dim))}
function chip(s,x,y,w,active=false){rect(x,y,w,35,active?P.raised:P.panel,6);mono(s,x+12,y+7,17,active?P.accent:P.dim)}
function tick(x,y){c.strokeStyle=P.ok;c.lineWidth=2;c.beginPath();c.moveTo(x,y+6);c.lineTo(x+5,y+11);c.lineTo(x+15,y);c.stroke()}
function dots(x,y,t){for(let j=0;j<3;j++)for(let i=0;i<3;i++){group(.2+.8*(.5+.5*Math.sin(t*4-i-j)),()=>rect(x+i*9,y+j*9,5,5,P.accent))}}
function frame(x,y,w,h,name){rect(x,y,w,h,P.panel,12);c.strokeStyle=P.line;c.lineWidth=1;c.strokeRect(x+.5,y+.5,w-1,h-1);line(x,y+49,x+w,y+49);logo(x+14,y+7,36);mono(name,x+61,y+16,17);mono('−    □    ×',x+w-126,y+15,18,P.mute)}
function intro(t){
 logo(824,168,272,ease(t/1.8));
 enter(t,.8,()=>center('让想法成形。',490,100,P.fg,600),14);
 enter(t,1.4,()=>center('Give ideas form.',626,30,P.dim),12);
 enter(t,2,()=>{line(815,725,1105,725);center('砚  /  INKSTONE',774,25,P.dim)},10);
 enter(t,3.1,()=>{mono('> 从一个想法开始',753,894,25,P.accent);if(t%1>.42)rect(1145,895,14,26,P.accent)},4);
}
function workspace(t){chrome(1,'一个想法');title('01 / BEGIN','把想法，放进工作空间。','对话、项目与文件，在同一处展开。',t);
 enter(t,.4,()=>{
 const x=120,y=405,w=1680,h=534;frame(x,y,w,h,'Inkstone     /     编码');
 rect(x+1,y+50,273,h-80,P.panel);line(x+274,y+50,x+274,y+h-30);
 mono('+  新对话',x+27,y+78,21);mono('项目',x+27,y+143,17,P.mute);text('网站改版',x+27,y+184,22);
 rect(x+15,y+228,243,43,P.raised,6);text('从想法到首页',x+31,y+239,20,P.accent);text('品牌素材',x+31,y+294,20,P.dim);text('文档与说明',x+31,y+342,20,P.dim);
 const typed='把这份想法，做成一个清楚、安静的首页。'.slice(0,Math.floor(Math.max(0,t-1)*17));
 rect(x+318,y+88,876,67,P.raised,8);text(typed,x+341,y+108,26);if(t<3.5)rect(x+342+c.measureText(typed).width,y+109,12,29,P.accent);
 enter(t,2.6,()=>{text('先整理内容结构，再把设计落到文件。',x+340,y+211,27);mono('›  阅读资料     /     形成结构     /     编写页面',x+340,y+274,20,P.dim);line(x+340,y+315,x+1110,y+315)});
 rect(x+318,y+383,1033,95,P.raised,12);text('继续补充你的想法…',x+342,y+407,23,P.mute);mono('@ 文件    / 命令',x+342,y+449,16);chip('发送 ↑',x+1240,y+417,84,true);
 line(x+1390,y+50,x+1390,y+h-30);mono('工作面板',x+1420,y+82,19);['文件','审查','浏览器','终端'].forEach((s,i)=>text(s,x+1420,y+145+i*65,22,i===0?P.accent:P.dim));
 line(x,y+h-30,x+w,y+h-30);mono('项目：website      /      本地工作空间',x+20,y+h-23,14,P.mute);
 },12);
}
function action(t){chrome(2,'一步步推进');title('02 / ACT','每一步，都看得清楚。','从读取资料到修改文件，过程与产出有迹可循。',t);
 enter(t,.3,()=>{frame(120,413,962,506,'执行过程');
 const rows=[['读取品牌与内容资料','3 份文件'],['梳理页面信息结构','结构已整理'],['编写首页与样式','2 份文件'],['查看生成的页面','浏览器预览']];
 rows.forEach(([s,r],i)=>{const done=t>1.4+i*1.3;group(clamp((t-.5-i*.55)/.65),()=>{if(done)tick(158,505+i*93);else rect(161,510+i*93,8,8,P.accent);text(s,198,499+i*93,25);mono(r,831,504+i*93,17,done?P.dim:P.mute);if(i<3)line(158,560+i*93,1045,560+i*93)})});
 },12);
 enter(t,1.1,()=>{frame(1130,413,670,506,'index.html   /   改动审查');mono('18',1152,510,19,P.mute);mono('<main class="inkstone">',1210,510,22);rect(1198,554,568,48,P.raised,4);mono('+ <h1>让想法成形。</h1>',1210,567,22,P.ok);mono('+ <p>从此刻开始。</p>',1210,620,22,P.ok);mono('  </main>',1210,673,22);line(1163,745,1764,745);mono('文件预览   /   改动审查',1163,778,19);mono('终端       /   内置浏览器',1163,817,19);},12);
}
function artifact(t){P=light;rect(0,0,W,H,P.bg);chrome(3,'一份成果');title('03 / CREATE','让对话，成为一份作品。','可阅读、可编辑，也可以继续完善。',t);
 enter(t,.3,()=>{frame(720,394,1080,552,'成果    /    首页内容方案.md');text('让想法成形。',785,501,48,P.fg,600);text('一个专注于内容与行动的 AI 工作空间。',787,580,26,P.dim);line(787,642,1720,642);mono('01  清楚地表达',787,684,22,P.accent);text('让内容成为中心，让下一步输入触手可及。',787,727,25);mono('02  从思路到行动',787,791,22,P.accent);text('与 AI 一起整理资料、修改文件、查看结果。',787,834,25);},14);
 const items=[['可编辑正文','在已有成果上继续修改'],['版本记录','保留每一次推进的轨迹'],['Markdown 导出','把作品带到下一步']];
 items.forEach(([a,b],i)=>enter(t,.8+i*.7,()=>{mono(`0${i+1}`,123,444+i*156,19,P.accent);text(a,180,438+i*156,30,P.fg,600);text(b,180,485+i*156,23,P.dim);line(180,548+i*156,621,548+i*156)},10));
}
function knowledge(t){chrome(4,'日常积累');title('04 / CONTINUE','每次开始，都有所积累。','围绕主题组织资料、对话与成果。',t);
 const cards=[{x:120,n:'01',title:'资料',sub:'把来源放在手边',rows:['设计原则.md','阅读笔记.md','参考资料.pdf']},{x:692,n:'02',title:'对话',sub:'让思考不断深入',rows:['梳理问题','对照不同思路','跟着导师学']},{x:1264,n:'03',title:'成果',sub:'把理解留下来',rows:['主题总结','行动清单','可继续编辑的正文']}];
 cards.forEach((a,i)=>enter(t,.4+i*.5,()=>{rect(a.x,430,536,446,P.panel,12);mono(a.n,a.x+34,465,20,P.accent);text(a.title,a.x+34,514,43,P.fg,600);text(a.sub,a.x+34,579,24,P.dim);line(a.x+34,631,a.x+502,631);a.rows.forEach((s,j)=>{rect(a.x+37,681+j*57,5,5,P.accent);text(s,a.x+61,670+j*57,23,P.dim)})},16));
 enter(t,2.4,()=>{line(389,920,1531,920,P.line);[389,960,1531].forEach(x=>rect(x-4,916,8,8,P.accent));mono('一个主题空间 · 连接资料、思考与作品',703,957,20,P.dim)},4);
}
function outro(t){logo(225,265,266,ease(t/1.4));enter(t,.3,()=>{text('砚',559,307,94,P.fg,600);text('Inkstone',687,322,71,P.fg,400);line(563,441,1620,441)});
 enter(t,.8,()=>text('让想法成形。',551,499,102,P.fg,600));enter(t,1.4,()=>text('一个专注于内容与行动的桌面 AI 工作空间。',561,646,30,P.dim));
 enter(t,2.3,()=>{mono('WINDOWS   /   多模型接入   /   深浅主题',563,764,21,P.dim);mono('github.com/Yu-DaTouX/Inkstone',563,820,24,P.accent)});
 enter(t,3,()=>{line(120,958,1800,958);mono('从一个想法，到一份作品。',120,993,20,P.dim);mono('INKSTONE / 砚',1609,993,18,P.dim)});
}
const scenes=[{start:0,end:6,draw:intro},{start:6,end:15,draw:workspace},{start:15,end:23,draw:action},{start:23,end:32,draw:artifact},{start:32,end:40,draw:knowledge},{start:40,end:48,draw:outro}];
window.renderAt=function(time){const t=Math.max(0,Math.min(47.999,time));P=dark;c.globalAlpha=1;rect(0,0,W,H,P.bg);const s=scenes.find(s=>t>=s.start&&t<s.end);s.draw(t-s.start);const fade=Math.min(clamp((t-s.start)/.45),s.end===48?1:clamp((s.end-t)/.45));group(1-fade,()=>rect(0,0,W,H,s.draw===artifact?light.bg:dark.bg));};
let playing=false,current=0,last=0;
const play=document.getElementById('play'),seek=document.getElementById('seek'),clock=document.getElementById('time');
function sync(){seek.value=current;clock.textContent=`00:${String(Math.floor(current)).padStart(2,'0')} / 00:48`;play.textContent=playing?'暂停':'播放'}
function toggle(){if(current>=48)current=0;playing=!playing;sync()}
play.onclick=toggle;document.getElementById('restart').onclick=()=>{current=0;playing=true;sync()};seek.oninput=()=>{current=+seek.value;sync();renderAt(current)};
document.getElementById('full').onclick=()=>canvas.requestFullscreen();
document.addEventListener('keydown',e=>{if(e.target.tagName==='INPUT'||e.target.tagName==='BUTTON')return;if(e.code==='Space'){e.preventDefault();toggle()}if(e.code==='ArrowRight'||e.code==='ArrowLeft'){e.preventDefault();current=Math.max(0,Math.min(48,current+(e.code==='ArrowRight'?1:-1)));renderAt(current);sync()}});
function loop(now){if(playing){current=Math.min(48,current+(now-last)/1000);renderAt(current);if(current===48)playing=false;sync()}last=now;requestAnimationFrame(loop)}
renderAt(2.7);requestAnimationFrame(loop);window.FILM={duration:DURATION,scenes:scenes.map(({start,end})=>({start,end}))};
