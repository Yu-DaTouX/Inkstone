import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const original=await readFile('scripts/test-light-client-live.mjs','utf8')
let source=original.replace("[join(root, 'out/main/index.js')]","[join(root, 'scripts/fixtures/model-selection-main.mjs')]")
assert.notEqual(source,original,'Isolated harness entry marker changed')
if(process.argv.includes('--extended')){
 const marker="[['light', 'light', '1440x1000'], ['dark', 'dark', '1440x1000'], ['narrow', 'dark', '940x900']]"
 assert(source.includes(marker))
 source=source.replace(marker,"[['light','light','1440x1000'],['dark','dark','1440x1000'],['narrow','dark','940x900'],['compact','dark','800x640'],['english','light','940x900']]")
 source=source.replace("lang: 'zh-CN'","lang: name === 'english' ? 'en-US' : 'zh-CN'")
}
await mkdir('out/test',{recursive:true})
const file=resolve('out/test/model-ui-runner.mjs');await writeFile(file,source)
const child=spawn(process.execPath,[file],{env:{...process.env,YAN_LIGHT_PROBE:'scripts/probe/model-selection.js',YAN_LIGHT_EVIDENCE:`.local-docs/evidence/model-selection-${Date.now()}`,YAN_LIGHT_FIXTURE_SESSIONS:'1'},windowsHide:true,stdio:'inherit'})
const code=await new Promise(resolve=>child.once('exit',resolve));if(code!==0)process.exit(code??1)
const recovery=original.replace("[['light', 'light', '1440x1000'], ['dark', 'dark', '1440x1000'], ['narrow', 'dark', '940x900']]","[['recovery','dark','940x900']]")
 .replace('onboardingDone: true,','onboardingDone: true, lastMainModel: { provider: \'retired-fixture\', id: \'gone\' },')
const recoveryFile=resolve('out/test/model-recovery-runner.mjs');await writeFile(recoveryFile,recovery)
const reset=spawn(process.execPath,[recoveryFile],{env:{...process.env,YAN_LIGHT_PROBE:'scripts/probe/model-default-recovery.js',YAN_LIGHT_EVIDENCE:`.local-docs/evidence/model-recovery-${Date.now()}`},windowsHide:true,stdio:'inherit'})
reset.once('exit',code=>process.exit(code??1))
