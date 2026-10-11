export const WIDGET_STATE_BRIDGE = `(function(){
var custom=null;
function fields(){return Array.from(document.querySelectorAll('input,select,textarea')).filter(function(e){return !['password','file','hidden','submit','button','reset','image'].includes(e.type)})}
window.setInkstoneState=function(value){custom=JSON.parse(JSON.stringify(value))};
addEventListener('message',function(e){
if(e.source!==parent||!e.data||e.data.yanWidgetState!==1)return;
var d=e.data;
if(d.type==='capture'&&typeof d.request==='string'){
var values=fields().slice(0,200).map(function(e){return {id:e.id,name:e.name,type:e.type,value:e.value.slice(0,8000),checked:e.checked,selected:e.multiple?Array.from(e.selectedOptions).map(function(o){return o.value}):undefined}});
try{var text=JSON.stringify({fields:values,custom:custom});parent.postMessage({yanWidget:1,type:'state',request:d.request,text:text.length<=65536?text:null},'*')}catch(_){}
}else if(d.type==='restore'&&d.state&&Array.isArray(d.state.fields)){
var controls=fields();d.state.fields.slice(0,200).forEach(function(v,i){var e=controls[i];if(!e||e.id!==v.id||e.name!==v.name||e.type!==v.type||typeof v.value!=='string')return;e.value=v.value;if(typeof v.checked==='boolean')e.checked=v.checked;if(e.multiple&&Array.isArray(v.selected))Array.from(e.options).forEach(function(o){o.selected=v.selected.includes(o.value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))});
custom=d.state.custom;window.dispatchEvent(new CustomEvent('inkstone:restore',{detail:custom}));
}
});})();`
