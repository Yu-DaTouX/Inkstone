const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const ts = require('typescript');
const root=process.cwd();
const dest=fs.mkdtempSync(path.join(os.tmpdir(),'yan-project-audit-'));
const all=[], owned=[], errors=[], links=[];
const counts={};
const ignored= new Set(cp.execFileSync('git',['ls-files','--others','--ignored','--exclude-standard','-z'],{maxBuffer:64*1024*1024}).toString().split('\0').filter(Boolean));
const tracked=new Set(cp.execFileSync('git',['ls-files','-z']).toString().split('\0').filter(Boolean));
function group(p) {
 if(p.startsWith('release/砚数据/')) return '用户真实数据（仅元数据）';
 if(p.startsWith('.git/')) return 'Git 元数据';
 if(p.startsWith('node_modules/')) return '第三方依赖';
 if(p.startsWith('resources/pi-runtime/')) return '内置运行时生成物';
 if(p.startsWith('release/')) return '发布产物';
 if(p.startsWith('out/')) return '构建产物';
 if(p.startsWith('.backup/')) return '手工备份';
 if(p.endsWith('.tsbuildinfo')) return '增量缓存';
 if(p.startsWith('docs/design/preview/')||/\.(png|gif|ico|ttf|woff2?|jpg|webp)$/i.test(p)) return '视觉与二进制资源';
 if(p.startsWith('src/')) return '应用源码';
 if(p.startsWith('scripts/')) return '测试与维护脚本';
 if(p.startsWith('resources/pi-extensions/')) return '自有扩展源码';
 if(p.startsWith('docs/')) return '文档与设计资产';
 return '根目录配置与入口';
}
const metadataOnly=new Set(['用户真实数据（仅元数据）','Git 元数据','第三方依赖','内置运行时生成物','发布产物','构建产物','手工备份','增量缓存']);
function visit(dir) {
 let entries; try {entries=fs.readdirSync(dir,{withFileTypes:true});}catch(e){errors.push({path:path.relative(root,dir),code:e.code});return;}
 for(const ent of entries){
  const abs=path.join(dir,ent.name), p=path.relative(root,abs).replaceAll('\\','/');
  if(ent.isSymbolicLink()){links.push({path:p,policy:'不跨链接遍历'});continue;}
  if(ent.isDirectory()){visit(abs);continue;}
  try {
   const stat=fs.statSync(abs), category=group(p);
   const row={path:p,category,bytes:stat.size,modified:stat.mtime.toISOString(),git:tracked.has(p)?'tracked':ignored.has(p)?'ignored':'untracked',review:'metadata'};
   counts[category]??={files:0,bytes:0};counts[category].files++;counts[category].bytes+=stat.size;
   if(!metadataOnly.has(category)&& !p.startsWith('scripts/audit/')) {
    const data=fs.readFileSync(abs);row.sha256=crypto.createHash('sha256').update(data).digest('hex');
    if(!data.subarray(0,8192).includes(0)&& !/\.(png|gif|ico|ttf|woff2?|jpg|webp)$/i.test(p)) {
     const text=data.toString('utf8'); row.lines=text.split(/\r?\n/).length;row.review='全文机器扫描；人工结论另列证据';
     row.markers=[...text.matchAll(/^.*(?:TODO|FIXME|HACK|XXX|not implemented|暂未|尚未|即将支持).*/gmi)].slice(0,35).map(m=>({line:text.slice(0,m.index).split('\n').length,text:m[0].slice(0,220)}));
     if(/\.[cm]?[jt]sx?$/.test(p)) {
      const source=ts.createSourceFile(p,text,ts.ScriptTarget.Latest,true,p.endsWith('.tsx')?ts.ScriptKind.TSX:p.endsWith('.ts')?ts.ScriptKind.TS:ts.ScriptKind.JS);
      row.syntax=source.parseDiagnostics.map(d=>({line:source.getLineAndCharacterOfPosition(d.start||0).line+1,message:ts.flattenDiagnosticMessageText(d.messageText,' ')}));
      row.symbols=[];row.imports=[];
      function parse(n){
       if((ts.isFunctionDeclaration(n)||ts.isClassDeclaration(n)||ts.isInterfaceDeclaration(n)||ts.isTypeAliasDeclaration(n))&&n.name)row.symbols.push({name:n.name.getText(source),line:source.getLineAndCharacterOfPosition(n.pos).line+1});
       if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier))row.imports.push(n.moduleSpecifier.text);
       ts.forEachChild(n,parse);
      }
      parse(source);
     }
     if(p.endsWith('.json')){try{JSON.parse(text);row.json='valid';}catch(e){row.json=e.message;}}
     if(p.endsWith('.md'))row.headings=text.split('\n').filter(l=>/^#{1,4} /.test(l));
    } else row.review='二进制大小与 SHA256；未逐图视觉验收';
    owned.push(row);
   }
   all.push(row);
  }catch(e){errors.push({path:p,code:e.code});}
 }
}
visit(root);
const syntax=owned.flatMap(f=>(f.syntax||[]).map(e=>({path:f.path,...e})));
const missingTracked=[...tracked].filter(p=>!fs.existsSync(path.join(root,p)));
const summary={created:new Date().toISOString(),root,totalFiles:all.length,ownedFiles:owned.length,counts,links,errors,missingTracked,syntaxErrors:syntax,dest};
fs.writeFileSync(path.join(dest,'all-files-private.json'),JSON.stringify(all,null,2));
fs.writeFileSync(path.join(dest,'owned-files.json'),JSON.stringify(owned,null,2));
fs.writeFileSync(path.join(dest,'summary.json'),JSON.stringify(summary,null,2));
fs.writeFileSync(path.join(dest,'git-status-before.txt'),cp.execFileSync('git',['status','--short']).toString());
console.log(JSON.stringify(summary,null,2));
