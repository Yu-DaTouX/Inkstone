import { mkdir, copyFile, writeFile } from 'node:fs/promises'
const assets = new URL('../android/app/src/main/assets/inkstone-terminal/', import.meta.url)
await mkdir(assets, { recursive: true })
await copyFile(new URL('../../node_modules/@xterm/xterm/lib/xterm.js', import.meta.url), new URL('xterm.js', assets))
await copyFile(new URL('../../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), new URL('xterm.css', assets))
await copyFile(new URL('../../node_modules/@xterm/addon-fit/lib/addon-fit.js', import.meta.url), new URL('addon-fit.js', assets))
await writeFile(new URL('index.html', assets), `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="xterm.css"><style>html,body,#terminal{height:100%;margin:0;background:#151515}</style></head><body><div id="terminal"></div><script src="xterm.js"></script><script src="addon-fit.js"></script><script>
const terminal=new Terminal({cols:80,rows:24,fontSize:12,scrollback:3000});terminal.open(document.getElementById('terminal'));
const fit=new FitAddon.FitAddon();terminal.loadAddon(fit);
function resize(){fit.fit();window.ReactNativeWebView.postMessage(JSON.stringify({kind:'size',cols:terminal.cols,rows:terminal.rows}));}window.addEventListener('resize',resize);
terminal.onData(data=>window.ReactNativeWebView.postMessage(JSON.stringify({kind:'input',data})));
function receive(event){try{const msg=JSON.parse(event.data);if(msg.kind==='snapshot')terminal.reset();if(msg.kind==='snapshot'||msg.kind==='delta'){if(Number.isInteger(msg.cols)&&Number.isInteger(msg.rows))terminal.resize(msg.cols,msg.rows);terminal.write(msg.data);}if(msg.kind==='size')terminal.resize(msg.cols,msg.rows);if(msg.kind==='theme'){terminal.options.theme={background:msg.background,foreground:msg.foreground};document.body.style.background=msg.background;}}catch{}}
document.addEventListener('message',receive);window.addEventListener('message',receive);
window.ReactNativeWebView.postMessage(JSON.stringify({kind:'ready'}));
resize();
</script></body></html>`, 'utf8')
