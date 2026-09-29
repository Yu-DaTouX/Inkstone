import {app,BrowserWindow} from 'electron';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname,resolve} from 'node:path';
import {once} from 'node:events';
const here=dirname(fileURLToPath(import.meta.url));
const out=resolve(here,'../../../.local-docs/showcase-2026-09-29');
mkdirSync(out,{recursive:true});
app.setPath('userData',join(out,'renderer-profile'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
const duration=48,fps=30;
// An original, quiet A-minor score: soft sine harmonics and a slow pulse.
function score(){const sr=48000,n=sr*duration,b=Buffer.alloc(44+n*4);b.write('RIFF');b.writeUInt32LE(36+n*4,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(sr,24);b.writeUInt32LE(sr*4,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*4,40);const notes=[220,261.6256,329.6276,391.9954,293.6648,261.6256,329.6276,246.9417];for(let i=0;i<n;i++){const t=i/sr,beat=Math.floor(t/.75),u=t% .75,f=notes[beat%notes.length],env=(1-Math.exp(-u*35))*Math.exp(-u*4.8),fade=Math.min(1,t/2,(duration-t)/3);for(let ch=0;ch<2;ch++){const det=ch?1.001:1;const pluck=(Math.sin(2*Math.PI*f*t*det)+.17*Math.sin(2*Math.PI*f*2*t))*env*.12;const pad=(Math.sin(2*Math.PI*110*t)+Math.sin(2*Math.PI*164.8138*t+ch*.3))*.025*(.8+.2*Math.sin(t*.4));b.writeInt16LE(Math.round((pluck+pad)*fade*32767),44+i*4+ch*2)}}writeFileSync(join(out,'score.wav'),b)}
app.whenReady().then(async()=>{
let win,encoder;
try{
score();win=new BrowserWindow({width:1920,height:1080,show:false,webPreferences:{backgroundThrottling:false,contextIsolation:true}});
await win.loadFile(join(here,'index.html'));
win.webContents.on('console-message',(_e,d)=>{if(d.level==='error')console.error(d.message)});
await win.webContents.executeJavaScript('document.fonts.ready');
for(const [name,t] of [['01-opening',3.5],['02-workspace',11],['03-action',21],['04-artifact',28],['05-knowledge',37],['06-end',46]]){const uri=await win.webContents.executeJavaScript(`renderAt(${t});document.getElementById('film').toDataURL('image/png')`);writeFileSync(join(out,name+'.png'),Buffer.from(uri.split(',')[1],'base64'))}
if(!process.argv.includes('--stills')){
encoder=spawn('ffmpeg',['-y','-f','image2pipe','-vcodec','mjpeg','-framerate',String(fps),'-i','pipe:0','-i',join(out,'score.wav'),'-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-t',String(duration),'-movflags','+faststart',join(out,'Inkstone-Give-Ideas-Form-1080p.mp4')],{stdio:['pipe','ignore','pipe'],windowsHide:true});
let err='';encoder.stderr.on('data',b=>{err=(err+b).slice(-4000)});const completion=once(encoder,'close');
for(let i=0;i<fps*duration;i++){const uri=await win.webContents.executeJavaScript(`renderAt(${i/fps});document.getElementById('film').toDataURL('image/jpeg',0.94)`);if(!encoder.stdin.write(Buffer.from(uri.split(',')[1],'base64')))await once(encoder.stdin,'drain');if(i%(fps*4)===0)console.log(`Rendered ${i/fps} / ${duration}s`)}
encoder.stdin.end();const [code]=await completion;if(code!==0)throw new Error(err);console.log('Video rendered: '+out);
}else console.log('Stills rendered: '+out);
win.destroy();app.quit();
}catch(error){console.error(error);encoder?.kill();win?.destroy();app.exit(1)}
});
