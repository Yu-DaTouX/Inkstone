export const HTML_CANVAS_CHANNEL = 'yan-canvas'
export const HTML_CANVAS_TOOL_KIND = 'tool'
export const HTML_CANVAS_COMPOSITION_KIND = 'composition'
export const HTML_CANVAS_TIMELINE_KIND = 'timeline'
export const HTML_CANVAS_TIME_KIND = 'time'
export const HTML_CANVAS_SCROLL_KIND = 'scroll'
export const HTML_CANVAS_RESOLVE_KIND = 'resolve'
export const HTML_CANVAS_RESOLVE_REPLY_KIND = 'resolve-reply'
export const HTML_CANVAS_BRIDGE_MARKER = 'data-yan-canvas'
export const HTML_CANVAS_BRIDGE_SCOPE = 'YAN_CANVAS'

export const CANVAS_RESOLVE_TIMEOUT_MS = 500

export const CANVAS_INFO_TEXT_MAX = 200
export const CANVAS_INFO_HTML_MAX = 2000
export const CANVAS_COMPOSITION_CLIP_LIMIT = 200

export const CANVAS_BRIDGE_TOOLS = ['inspect', 'comment', 'edit'] as const
export type CanvasBridgeTool = (typeof CANVAS_BRIDGE_TOOLS)[number]

export interface CanvasElementRect {
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasElementStyles {
  color: string
  backgroundColor: string
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  letterSpacing: string
  textAlign: string
  padding: string
  margin: string
  borderRadius: string
  display: string
  width: string
  height: string
}

export const CANVAS_STYLE_KEYS: readonly (keyof CanvasElementStyles)[] = [
  'color',
  'backgroundColor',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'padding',
  'margin',
  'borderRadius',
  'display',
  'width',
  'height'
]

export interface CanvasElementInfoPayload {
  path: string
  selector: string
  tag: string
  id: string
  classes: string[]
  text: string
  rect: CanvasElementRect
  styles: CanvasElementStyles
  sourceOffset?: number
  outerHtml: string
}

export interface CanvasCompositionClip {
  id: string
  label: string
  start: number
  duration: number
  track: number
}

export interface CanvasComposition {
  id: string
  width: number
  height: number
  duration: number
  clips: CanvasCompositionClip[]
  hasTimeline: boolean
}

export interface CanvasTimeUpdate {
  t: number
  paused: boolean
}

export type CanvasTimelineAction = 'seek' | 'play' | 'pause'

export interface CanvasResolveTarget {
  selector: string
  path: string
  text?: string
}

export type CanvasBridgeEvent =
  | { kind: 'ready' }
  | { kind: 'scroll' }
  | { kind: 'resolve'; id: string; rect: CanvasElementRect | null }
  | { kind: 'hover'; info: CanvasElementInfoPayload | null }
  | { kind: 'select'; info: CanvasElementInfoPayload }
  | { kind: 'composition'; composition: CanvasComposition }
  | { kind: 'time'; time: CanvasTimeUpdate }

const CANVAS_BRIDGE_SCRIPT = String.raw`;(function(){
var K=${JSON.stringify(HTML_CANVAS_CHANNEL)};
var ACTIVE={inspect:1,comment:1,edit:1};
var HOST_ATTRS=["data-yan-preview","data-yan-canvas"];
var tool=null;
var lastHover=null;
var cursorBefore=null;
var cursorSaved=false;
var scrollAt=0;
var listeners=[];
function isHost(el){
  if(!el||el.nodeType!==1||!el.hasAttribute)return false;
  for(var i=0;i<HOST_ATTRS.length;i++){if(el.hasAttribute(HOST_ATTRS[i]))return true}
  return false;
}
function siblingElements(el){
  var out=[];var p=el.parentElement;if(!p)return out;
  for(var i=0;i<p.children.length;i++){var child=p.children[i];if(!isHost(child))out.push(child)}
  return out;
}
function domPath(el){
  var parts=[];var node=el;
  while(node&&node.nodeType===1&&node!==document.body){
    var index=siblingElements(node).indexOf(node);
    if(index<0)return parts.join(".");
    parts.unshift(index);
    node=node.parentElement;
  }
  return parts.join(".");
}
function escapeIdent(value){
  try{return window.CSS&&window.CSS.escape?window.CSS.escape(String(value)):String(value)}catch(_){return String(value)}
}
function classTokens(el){
  var out=[];var list=el.classList?el.classList:[];
  for(var i=0;i<list.length;i++){var token=list[i];if(/^[A-Za-z_][A-Za-z0-9_-]*$/.test(token)&&out.length<3)out.push(token)}
  return out;
}
function uniqueFor(selector,el){
  try{var found=document.querySelectorAll(selector);return found.length===1&&found[0]===el}catch(_){return false}
}
function selectorFor(el){
  if(el===document.body)return "body";
  if(el.id&&uniqueFor("#"+escapeIdent(el.id),el))return "#"+el.id;
  var tag=el.tagName.toLowerCase();
  var simple=tag+classTokens(el).map(function(token){return "."+escapeIdent(token)}).join("");
  if(uniqueFor(simple,el))return simple;
  var parts=[];var node=el;var depth=0;
  while(node&&node.nodeType===1&&node!==document.body&&depth<6){
    var step=node.tagName.toLowerCase();
    if(node.id){
      parts.unshift("#"+escapeIdent(node.id));
      return parts.join(" > ");
    }
    var same=siblingElements(node).filter(function(other){return other.tagName===node.tagName});
    if(same.length>1)step+=":nth-of-type("+(same.indexOf(node)+1)+")";
    parts.unshift(step);
    var candidate=parts.join(" > ");
    if(uniqueFor(candidate,el))return candidate;
    node=node.parentElement;
    depth++;
  }
  return parts.join(" > ")||tag;
}
function truncate(value,limit){
  var text=value==null?"":String(value);
  return text.length>limit?text.slice(0,limit):text;
}
function textOf(el){
  return truncate((el.textContent||"").replace(/\s+/g," ").trim(),200);
}
function computed(cs,name){
  return String(cs.getPropertyValue(name)||"");
}
function sourceOffset(el){
  var raw=el.getAttribute("data-yan-src");
  if(raw===null)return null;
  var value=Number(raw);
  return isFinite(value)&&value>=0?Math.floor(value):null;
}
function infoFor(el){
  if(!el||el.nodeType!==1)return null;
  var rect=el.getBoundingClientRect();
  var cs=window.getComputedStyle(el);
  var classes=[];
  var list=el.classList?el.classList:[];
  for(var i=0;i<list.length;i++)classes.push(list[i]);
  var info={
    path:domPath(el),
    selector:selectorFor(el),
    tag:el.tagName.toLowerCase(),
    id:el.id||"",
    classes:classes,
    text:textOf(el),
    rect:{x:Math.round(rect.left),y:Math.round(rect.top),w:Math.round(rect.width),h:Math.round(rect.height)},
    styles:{
      color:computed(cs,"color"),
      backgroundColor:computed(cs,"background-color"),
      fontFamily:computed(cs,"font-family"),
      fontSize:computed(cs,"font-size"),
      fontWeight:computed(cs,"font-weight"),
      lineHeight:computed(cs,"line-height"),
      letterSpacing:computed(cs,"letter-spacing"),
      textAlign:computed(cs,"text-align"),
      padding:computed(cs,"padding"),
      margin:computed(cs,"margin"),
      borderRadius:computed(cs,"border-radius"),
      display:computed(cs,"display"),
      width:computed(cs,"width"),
      height:computed(cs,"height")
    },
    outerHtml:truncate(el.outerHTML,2000)
  };
  var offset=sourceOffset(el);
  if(offset!==null)info.sourceOffset=offset;
  return info;
}
function post(kind,payload){
  var message={};
  message[K]=kind;
  message.nonce=YAN_CANVAS.nonce;
  if(payload!==undefined)message.info=payload;
  try{parent.postMessage(message,"*")}catch(_){}
}
function targetOf(ev){
  var el=ev.target;
  while(el&&el.nodeType!==1)el=el.parentElement;
  return isHost(el)?null:el;
}
function emitHover(el){
  if(el===lastHover)return;
  lastHover=el;
  post("hover",el?infoFor(el):null);
}
function block(ev){
  ev.preventDefault();
  ev.stopPropagation();
  if(ev.stopImmediatePropagation)ev.stopImmediatePropagation();
}
function onMove(ev){
  if(!tool)return;
  emitHover(targetOf(ev));
}
function onPress(ev){
  if(!tool)return;
  var el=targetOf(ev);
  if(!el)return;
  block(ev);
  lastHover=el;
  post("select",infoFor(el));
}
function onScroll(){
  if(!tool)return;
  var now=Date.now();
  if(now-scrollAt>=120){
    scrollAt=now;
    post("scroll");
  }
  if(lastHover)post("hover",infoFor(lastHover));
}
function setCursor(on){
  var root=document.documentElement;
  if(!root)return;
  if(on){
    if(!cursorSaved){cursorBefore=root.style.getPropertyValue("cursor");cursorSaved=true}
    root.style.setProperty("cursor","crosshair");
    return;
  }
  if(!cursorSaved)return;
  cursorSaved=false;
  if(cursorBefore)root.style.setProperty("cursor",cursorBefore);
  else root.style.removeProperty("cursor");
}
function attach(){
  window.addEventListener("pointermove",onMove,true);
  window.addEventListener("pointerdown",onPress,true);
  window.addEventListener("pointerup",block,true);
  window.addEventListener("click",block,true);
  window.addEventListener("dblclick",block,true);
  window.addEventListener("scroll",onScroll,true);
}
function detach(){
  window.removeEventListener("pointermove",onMove,true);
  window.removeEventListener("pointerdown",onPress,true);
  window.removeEventListener("pointerup",block,true);
  window.removeEventListener("click",block,true);
  window.removeEventListener("dblclick",block,true);
  window.removeEventListener("scroll",onScroll,true);
}
function activate(next){
  if(tool===next)return;
  tool=next;
  lastHover=null;
  if(next)attach();
  else detach();
  setCursor(Boolean(next));
  for(var i=0;i<listeners.length;i++){try{listeners[i](next)}catch(_){}}
  post("hover",null);
}
window.addEventListener("message",function(ev){
  if(ev.source!==parent)return;
  var data=ev.data;
  if(!data||typeof data!=="object")return;
  if(data[K]!==${JSON.stringify(HTML_CANVAS_TOOL_KIND)})return;
  activate(typeof data.tool==="string"&&ACTIVE[data.tool]?data.tool:null);
});
YAN_CANVAS.bridge={channel:K,active:function(){return tool},info:infoFor,isHost:isHost,post:post,onTool:function(fn){if(typeof fn==="function")listeners.push(fn)}};
post("ready");
if(document.readyState!=="complete")window.addEventListener("load",function(){post("ready")},{once:true});
})();`

const CANVAS_EDIT_SCRIPT = String.raw`;(function(){
var K=${JSON.stringify(HTML_CANVAS_CHANNEL)};
var HOST_ATTRS=["data-yan-preview","data-yan-canvas"];
var active=null;
function bridge(){return YAN_CANVAS.bridge||null}
function isHost(el){
  if(!el||el.nodeType!==1||!el.hasAttribute)return false;
  for(var i=0;i<HOST_ATTRS.length;i++){if(el.hasAttribute(HOST_ATTRS[i]))return true}
  return false;
}
function childrenOf(node){
  var out=[];
  if(!node||!node.children)return out;
  for(var i=0;i<node.children.length;i++){var child=node.children[i];if(!isHost(child))out.push(child)}
  return out;
}
function find(path){
  if(typeof path!=="string"||!document.body)return null;
  if(path==="")return document.body;
  var parts=path.split(".");
  var node=document.body;
  for(var i=0;i<parts.length;i++){
    if(parts[i]==="")continue;
    var index=Number(parts[i]);
    if(!isFinite(index)||index<0)return null;
    node=childrenOf(node)[Math.floor(index)];
    if(!node)return null;
  }
  return node;
}
function postSelect(el){
  var b=bridge();
  if(!el||!b||typeof b.post!=="function"||typeof b.info!=="function")return;
  try{b.post("select",b.info(el))}catch(_){}
}
function restore(){
  if(!active)return;
  var el=active.el;
  if(active.style===null)el.removeAttribute("style");
  else el.setAttribute("style",active.style);
  if(active.html!==null)el.innerHTML=active.html;
  active=null;
}
function apply(payload){
  var el=find(payload&&payload.path);
  if(!el)return;
  if(!active||active.el!==el){
    restore();
    active={el:el,style:el.getAttribute("style"),html:null};
  }
  if(active.style===null)el.removeAttribute("style");
  else el.setAttribute("style",active.style);
  var styles=payload.styles||{};
  for(var key in styles){
    if(!Object.prototype.hasOwnProperty.call(styles,key))continue;
    if(!/^[a-z-]+$/.test(key))continue;
    var value=styles[key];
    if(value===null||value===undefined||value==="")continue;
    try{el.style.setProperty(key,String(value))}catch(_){}
  }
  if(typeof payload.text==="string"&&!el.children.length){
    if(active.html===null)active.html=el.innerHTML;
    el.textContent=payload.text;
  }
  postSelect(el);
}
window.addEventListener("message",function(ev){
  if(ev.source!==parent)return;
  var data=ev.data;
  if(!data||typeof data!=="object")return;
  var kind=data[K];
  if(kind==="edit-preview"){apply(data);return}
  if(kind==="edit-reset"){restore();return}
  if(kind==="edit-select"){postSelect(find(data.path))}
});
var linked=bridge();
if(linked&&typeof linked.onTool==="function")linked.onTool(function(tool){if(tool!=="edit")restore()});
})();`

const CANVAS_COMPOSITION_SCRIPT = String.raw`;(function(){
var K=${JSON.stringify(HTML_CANVAS_CHANNEL)};
var CLIP_LIMIT=${JSON.stringify(CANVAS_COMPOSITION_CLIP_LIMIT)};
var SCAN_MS=100;
var SCAN_TRIES=60;
var REPORT_MS=100;
var root=null;
var id="";
var total=0;
var clips=[];
var signature="";
var controller=null;
var time=0;
var playing=false;
var playFrom=0;
var playStart=0;
var lastReport=0;
var raf=0;
var scanTimer=0;
var scans=0;
function finite(value){
  var n=Number(value);
  return isFinite(n)?n:NaN;
}
function clamp(value,high){
  var n=finite(value);
  if(isNaN(n))n=0;
  if(n<0)n=0;
  if(high>0&&n>high)n=high;
  return n;
}
function timelines(){
  var list=window.__timelines;
  return list&&typeof list==="object"?list:null;
}
function resolveController(){
  var list=timelines();
  if(!list||!id)return null;
  var found=list[id];
  return found&&typeof found==="object"?found:null;
}
function duration(){
  if(controller&&typeof controller.duration==="function"){
    try{
      var value=finite(controller.duration());
      if(!isNaN(value)&&value>0)return value;
    }catch(_){}
  }
  return total;
}
function pausedNow(){
  if(controller&&typeof controller.paused==="function"){
    try{return Boolean(controller.paused())}catch(_){return !playing}
  }
  return !playing;
}
function animations(){
  try{return document.getAnimations?document.getAnimations():[]}catch(_){return []}
}
function frameWidth(){
  var value=root?finite(root.getAttribute("data-width")):NaN;
  if(isNaN(value)||value<=0)value=root?(root.clientWidth||root.offsetWidth||0):0;
  return Math.round(value);
}
function frameHeight(){
  var value=root?finite(root.getAttribute("data-height")):NaN;
  if(isNaN(value)||value<=0)value=root?(root.clientHeight||root.offsetHeight||0):0;
  return Math.round(value);
}
function labelOf(el){
  var named=(el.getAttribute("data-label")||el.getAttribute("aria-label")||"").trim();
  if(named)return named.slice(0,40);
  var text=(el.textContent||"").replace(/\s+/g," ").trim();
  if(text)return text.slice(0,24);
  if(el.id)return el.id;
  var list=el.classList||[];
  if(list.length)return "."+list[0];
  return el.tagName.toLowerCase();
}
function readClips(){
  var out=[];
  if(!root)return out;
  var nodes=root.querySelectorAll("[data-start]");
  for(var i=0;i<nodes.length;i++){
    if(out.length>=CLIP_LIMIT)break;
    var el=nodes[i];
    var start=finite(el.getAttribute("data-start"));
    if(isNaN(start)||start<0)continue;
    var raw=el.getAttribute("data-duration");
    var span=raw===null||raw===""?total-start:finite(raw);
    if(isNaN(span)||span<=0)span=Math.max(0,total-start);
    if(!(span>0))continue;
    var rawTrack=finite(el.getAttribute("data-track-index"));
    var track=isNaN(rawTrack)||rawTrack<0?0:Math.floor(rawTrack);
    out.push({id:el.id||"",label:labelOf(el),start:start,duration:span,track:track});
  }
  return out;
}
function composeSignature(){
  var parts=[id,frameWidth(),frameHeight(),total,controller?1:0,clips.length];
  for(var i=0;i<clips.length;i++){
    var clip=clips[i];
    parts.push(clip.id+","+clip.label+","+clip.start+","+clip.duration+","+clip.track);
  }
  return parts.join("|");
}
function postComposition(){
  var message={};
  message[K]=${JSON.stringify(HTML_CANVAS_COMPOSITION_KIND)};
  message.nonce=YAN_CANVAS.nonce;
  message.id=id;
  message.width=frameWidth();
  message.height=frameHeight();
  message.duration=total;
  message.clips=clips;
  message.hasTimeline=Boolean(controller);
  try{parent.postMessage(message,"*")}catch(_){}
}
function postTime(){
  var message={};
  message[K]=${JSON.stringify(HTML_CANVAS_TIME_KIND)};
  message.nonce=YAN_CANVAS.nonce;
  message.t=time;
  message.paused=playing?false:pausedNow();
  try{parent.postMessage(message,"*")}catch(_){}
}
function setAnimationTime(target){
  var list=animations();
  for(var i=0;i<list.length;i++){
    try{list[i].pause();list[i].currentTime=target*1000}catch(_){}
  }
}
function applyTime(target){
  if(controller&&typeof controller.seek==="function"){
    try{controller.seek(target)}catch(_){}
    return;
  }
  setAnimationTime(target);
}
function stopPlayback(){
  if(raf){
    cancelAnimationFrame(raf);
    raf=0;
  }
  if(controller&&typeof controller.pause==="function"){
    try{controller.pause()}catch(_){}
    return;
  }
  var list=animations();
  for(var i=0;i<list.length;i++){
    try{list[i].pause()}catch(_){}
  }
}
function seekTo(value){
  var high=duration();
  time=clamp(value,high);
  if(playing){
    playing=false;
    stopPlayback();
  }
  applyTime(high>0?Math.min(time,Math.max(0,high-0.001)):time);
  postTime();
  return time;
}
function currentTime(){
  var high=duration();
  if(controller&&typeof controller.time==="function"){
    try{
      var value=finite(controller.time());
      if(!isNaN(value))return clamp(value,high);
    }catch(_){}
  }
  if(!playing)return time;
  return clamp(playFrom+(performance.now()-playStart)/1000,high);
}
function tick(){
  raf=0;
  if(!playing)return;
  var high=duration();
  time=currentTime();
  if(high>0&&time>=high-0.001){
    time=high;
    pause();
    return;
  }
  var now=performance.now();
  if(now-lastReport>=REPORT_MS){
    lastReport=now;
    postTime();
  }
  raf=requestAnimationFrame(tick);
}
function play(){
  var high=duration();
  if(!(high>0))return;
  if(time>=high-0.001){
    time=0;
    applyTime(0);
  }
  playing=true;
  playFrom=time;
  playStart=performance.now();
  if(controller&&typeof controller.play==="function"){
    try{controller.play()}catch(_){}
  }else{
    var list=animations();
    for(var i=0;i<list.length;i++){
      try{list[i].play()}catch(_){}
    }
  }
  if(!raf)raf=requestAnimationFrame(tick);
  postTime();
}
function pause(){
  playing=false;
  stopPlayback();
  time=clamp(time,duration());
  postTime();
}
function detect(){
  if(!root){
    var found=document.querySelector("[data-composition-id]");
    if(!found)return false;
    root=found;
    id=(root.getAttribute("data-composition-id")||"").trim()||"composition";
    var value=finite(root.getAttribute("data-duration"));
    total=isNaN(value)||value<=0?0:value;
  }
  controller=resolveController()||controller;
  clips=readClips();
  var next=composeSignature();
  if(next!==signature){
    signature=next;
    postComposition();
  }
  return Boolean(controller)&&total>0;
}
function scan(){
  var done=false;
  try{done=detect()}catch(_){done=false}
  scans++;
  if((done||scans>=SCAN_TRIES)&&scanTimer){
    clearInterval(scanTimer);
    scanTimer=0;
  }
}
function start(){
  if(scanTimer)return;
  scan();
  if(!scanTimer)scanTimer=setInterval(scan,SCAN_MS);
}
window.addEventListener("message",function(ev){
  if(ev.source!==parent)return;
  var data=ev.data;
  if(!data||typeof data!=="object")return;
  if(data[K]!==${JSON.stringify(HTML_CANVAS_TIMELINE_KIND)})return;
  var resolved=resolveController();
  if(resolved&&resolved!==controller){
    controller=resolved;
    clips=readClips();
    signature=composeSignature();
    postComposition();
  }else{
    controller=resolved||controller;
  }
  if(data.action==="seek"){
    var at=finite(data.t);
    if(isNaN(at))return;
    seekTo(at);
    return;
  }
  if(data.action==="play"){
    play();
    return;
  }
  if(data.action==="pause")pause();
});
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});
else start();
window.addEventListener("load",start);
})();`

const CANVAS_RESOLVE_SCRIPT = String.raw`;(function(){
var K=${JSON.stringify(HTML_CANVAS_CHANNEL)};
var HOST_ATTRS=["data-yan-preview","data-yan-canvas"];
var TEXT_MAX=64;
function isHost(el){
  if(!el||el.nodeType!==1||!el.hasAttribute)return false;
  for(var i=0;i<HOST_ATTRS.length;i++){if(el.hasAttribute(HOST_ATTRS[i]))return true}
  return false;
}
function inHost(el){
  var node=el;
  while(node&&node.nodeType===1){
    if(isHost(node))return true;
    node=node.parentElement;
  }
  return false;
}
function childrenOf(node){
  var out=[];
  if(!node||!node.children)return out;
  for(var i=0;i<node.children.length;i++){var child=node.children[i];if(!isHost(child))out.push(child)}
  return out;
}
function bySelector(selector){
  if(typeof selector!=="string"||!selector.trim())return null;
  try{
    var found=document.querySelectorAll(selector);
    return found.length===1&&!inHost(found[0])?found[0]:null;
  }catch(_){return null}
}
function byPath(path){
  if(typeof path!=="string"||!document.body)return null;
  if(path==="")return document.body;
  var parts=path.split(".");
  var node=document.body;
  for(var i=0;i<parts.length;i++){
    if(parts[i]==="")continue;
    var index=Number(parts[i]);
    if(!isFinite(index)||index<0)return null;
    node=childrenOf(node)[Math.floor(index)];
    if(!node)return null;
  }
  return node;
}
function byText(text){
  var needle=String(text==null?"":text).replace(/\s+/g," ").trim().slice(0,TEXT_MAX);
  if(!needle||!document.body)return null;
  var walker=document.createTreeWalker(document.body,4);
  var node=null;
  while((node=walker.nextNode())){
    var value=node.nodeValue;
    if(!value||value.replace(/\s+/g," ").indexOf(needle)<0)continue;
    var host=node.parentElement;
    if(!host||inHost(host))continue;
    var range=document.createRange();
    range.selectNodeContents(node);
    var box=range.getBoundingClientRect();
    if(box.width>0&&box.height>0)return host;
  }
  return null;
}
function rectOf(el){
  var box=el.getBoundingClientRect();
  return {x:Math.round(box.left),y:Math.round(box.top),w:Math.round(box.width),h:Math.round(box.height)};
}
function reply(id,el){
  var message={};
  message[K]=${JSON.stringify(HTML_CANVAS_RESOLVE_REPLY_KIND)};
  message.nonce=YAN_CANVAS.nonce;
  message.id=id;
  message.rect=el?rectOf(el):null;
  try{parent.postMessage(message,"*")}catch(_){}
}
window.addEventListener("message",function(ev){
  if(ev.source!==parent)return;
  var data=ev.data;
  if(!data||typeof data!=="object")return;
  if(data[K]!==${JSON.stringify(HTML_CANVAS_RESOLVE_KIND)})return;
  var id=typeof data.id==="string"?data.id:"";
  if(!id)return;
  var found=null;
  try{found=bySelector(data.selector)||byPath(data.path)||byText(data.text)}catch(_){found=null}
  reply(id,found);
});
})();`

export const CANVAS_BRIDGE_PARTS: string[] = [CANVAS_BRIDGE_SCRIPT]

export function registerCanvasBridgePart(part: string): void {
  if (part && !CANVAS_BRIDGE_PARTS.includes(part)) CANVAS_BRIDGE_PARTS.push(part)
}

export function canvasBridgeRuntime(nonce?: string): string {
  const value = typeof nonce === 'string' ? nonce : ''
  const scope = `var ${HTML_CANVAS_BRIDGE_SCOPE}={nonce:${JSON.stringify(value)}};`
  const detach = 'var self=document.currentScript;if(self&&self.parentNode)self.parentNode.removeChild(self);'
  return `<script ${HTML_CANVAS_BRIDGE_MARKER}>(function(){${detach}${scope}${CANVAS_BRIDGE_PARTS.join('\n')}})();</script>`
}

export function isCanvasBridgeTool(value: unknown): value is CanvasBridgeTool {
  return typeof value === 'string' && (CANVAS_BRIDGE_TOOLS as readonly string[]).includes(value)
}

export function canvasToolMessage(tool: CanvasBridgeTool | string | null): Record<string, unknown> {
  return { [HTML_CANVAS_CHANNEL]: HTML_CANVAS_TOOL_KIND, tool: tool ?? '' }
}

export function canvasTimelineMessage(action: CanvasTimelineAction, t?: number): Record<string, unknown> {
  const message: Record<string, unknown> = { [HTML_CANVAS_CHANNEL]: HTML_CANVAS_TIMELINE_KIND, action }
  if (typeof t === 'number' && Number.isFinite(t)) message.t = t
  return message
}

export function canvasResolveMessage(id: string, target: CanvasResolveTarget): Record<string, unknown> {
  const message: Record<string, unknown> = { [HTML_CANVAS_CHANNEL]: HTML_CANVAS_RESOLVE_KIND, id }
  message.selector = typeof target.selector === 'string' ? target.selector.slice(0, 400) : ''
  message.path = typeof target.path === 'string' ? target.path.slice(0, 200) : ''
  if (typeof target.text === 'string' && target.text.trim()) message.text = target.text.slice(0, CANVAS_INFO_TEXT_MAX)
  return message
}

registerCanvasBridgePart(CANVAS_EDIT_SCRIPT)
registerCanvasBridgePart(CANVAS_COMPOSITION_SCRIPT)
registerCanvasBridgePart(CANVAS_RESOLVE_SCRIPT)

export function readCanvasElementInfo(value: unknown): CanvasElementInfoPayload | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const field = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '')
  const tag = field('tag')
  const selector = field('selector')
  if (!tag || !selector) return null
  const rectValue = raw.rect
  if (!rectValue || typeof rectValue !== 'object') return null
  const rectRaw = rectValue as Record<string, unknown>
  const finite = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate)
  if (!finite(rectRaw.x) || !finite(rectRaw.y) || !finite(rectRaw.w) || !finite(rectRaw.h)) return null
  const stylesRaw = raw.styles && typeof raw.styles === 'object' ? (raw.styles as Record<string, unknown>) : {}
  const styles = {} as CanvasElementStyles
  for (const key of CANVAS_STYLE_KEYS) styles[key] = typeof stylesRaw[key] === 'string' ? (stylesRaw[key] as string) : ''
  const classes = Array.isArray(raw.classes) ? raw.classes.filter((token): token is string => typeof token === 'string') : []
  const info: CanvasElementInfoPayload = {
    path: field('path'),
    selector,
    tag,
    id: field('id'),
    classes,
    text: field('text').slice(0, CANVAS_INFO_TEXT_MAX),
    rect: { x: rectRaw.x, y: rectRaw.y, w: rectRaw.w, h: rectRaw.h },
    styles,
    outerHtml: field('outerHtml').slice(0, CANVAS_INFO_HTML_MAX)
  }
  if (finite(raw.sourceOffset)) info.sourceOffset = Math.max(0, Math.floor(raw.sourceOffset))
  return info
}

export function readCanvasComposition(value: unknown): CanvasComposition | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const finite = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate)
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return null
  if (!finite(raw.width) || raw.width <= 0) return null
  if (!finite(raw.height) || raw.height <= 0) return null
  if (!finite(raw.duration) || raw.duration <= 0) return null
  if (!Array.isArray(raw.clips)) return null
  const clips: CanvasCompositionClip[] = []
  for (const entry of raw.clips.slice(0, CANVAS_COMPOSITION_CLIP_LIMIT)) {
    if (!entry || typeof entry !== 'object') continue
    const clip = entry as Record<string, unknown>
    if (!finite(clip.start) || clip.start < 0) continue
    if (!finite(clip.duration) || clip.duration <= 0) continue
    const track = finite(clip.track) && clip.track >= 0 ? Math.floor(clip.track) : 0
    clips.push({
      id: typeof clip.id === 'string' ? clip.id : '',
      label: typeof clip.label === 'string' ? clip.label.slice(0, CANVAS_INFO_TEXT_MAX) : '',
      start: clip.start,
      duration: clip.duration,
      track
    })
  }
  return {
    id,
    width: raw.width,
    height: raw.height,
    duration: raw.duration,
    clips,
    hasTimeline: raw.hasTimeline === true
  }
}

export function readCanvasTimeUpdate(value: unknown): CanvasTimeUpdate | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.t !== 'number' || !Number.isFinite(raw.t)) return null
  return { t: Math.max(0, raw.t), paused: raw.paused !== false }
}

export function readCanvasElementRect(value: unknown): CanvasElementRect | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const finite = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate)
  if (!finite(raw.x) || !finite(raw.y) || !finite(raw.w) || !finite(raw.h)) return null
  return { x: raw.x, y: raw.y, w: raw.w, h: raw.h }
}

export function readCanvasBridgeEvent(data: unknown, nonce?: string): CanvasBridgeEvent | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Record<string, unknown>
  if (typeof nonce === 'string') {
    const sent = raw.nonce
    if (!nonce || typeof sent !== 'string' || sent !== nonce) return null
  }
  const kind = raw[HTML_CANVAS_CHANNEL]
  if (kind === 'ready') return { kind: 'ready' }
  if (kind === HTML_CANVAS_SCROLL_KIND) return { kind: 'scroll' }
  if (kind === HTML_CANVAS_RESOLVE_REPLY_KIND) {
    const id = typeof raw.id === 'string' ? raw.id : ''
    if (!id) return null
    return { kind: 'resolve', id, rect: readCanvasElementRect(raw.rect) }
  }
  if (kind === 'hover') return { kind: 'hover', info: readCanvasElementInfo(raw.info) }
  if (kind === HTML_CANVAS_COMPOSITION_KIND) {
    const composition = readCanvasComposition(raw)
    return composition ? { kind: 'composition', composition } : null
  }
  if (kind === HTML_CANVAS_TIME_KIND) {
    const time = readCanvasTimeUpdate(raw)
    return time ? { kind: 'time', time } : null
  }
  if (kind === 'select') {
    const info = readCanvasElementInfo(raw.info)
    return info ? { kind: 'select', info } : null
  }
  return null
}
