import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyWorkflow, toApiPrompt } from '../integrations/comfyui/workflow.mjs'
import { comfyGenerate, loadVideoSource } from '../integrations/comfyui/generation.mjs'
import { createComfyService } from '../integrations/comfyui/service.mjs'

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)])
const V2V = 'v2v — 视频转视频(Video to Video)'
const T2V = 't2v — 文生视频(Text to Video)'
const DIRECTOR_WIDGETS = ['task_type', 'global_prompt', 'bd_grp_sample', 'cfg', 'seed', 'frame_rate', 'width', 'height', 'ref_max_size', 'total_frames', 'timeline_data', 'bd_grp_advanced', 'steps', 'sampler', 'scheduler', 'shift_video', 'shift_audio', 'bd_grp_perf', 'clear_vram_between_segments', 'export_source_images']

export function directorWorkflow(task = V2V) {
  const timeline = JSON.stringify({ version: 4, editMode: 'global', timelineMode: 'video', frameRate: 24, width: 384, height: 672, output: { mode: 'fixed', width: 384, height: 672, longEdge: 672 }, video: { fileName: '', videoFile: '' }, global: { taskType: task, prompt: '' }, segments: [], gen: { defaultFrameCount: 240 } })
  return {
    nodes: [
      { id: 1, type: 'UNETLoader', widgets_values: ['h3.safetensors', 'default'], outputs: [{ type: 'MODEL', links: [1] }] },
      { id: 21, type: 'LoraLoaderModelOnly', widgets_values: ['style.safetensors', 1], inputs: [{ name: 'model', link: 1 }], outputs: [{ type: 'MODEL', links: [2] }] },
      { id: 2, type: 'CLIPLoader', widgets_values: ['te.safetensors', 'boogu', 'default'], outputs: [{ type: 'CLIP', links: [3] }] },
      {
        id: 5, type: 'MiniMaxH3Director',
        widgets_values: [task, '', '采样设置', 1, 5, 'randomize', 24, 384, 672, 672, 0, timeline, '高级采样', 4, 'euler', 'simple', 12, 3, '性能', true, false, ''],
        inputs: [{ name: 'model', link: 2 }, { name: 'clip', link: 3 }, ...DIRECTOR_WIDGETS.map((name) => ({ name, widget: { name }, link: null }))],
        outputs: [{ type: 'IMAGE', links: [4] }]
      },
      { id: 6, type: 'CreateVideo', widgets_values: [24], inputs: [{ name: 'images', link: 4 }], outputs: [{ type: 'VIDEO', links: [5] }] },
      { id: 7, type: 'SaveVideo', widgets_values: ['MiniMax-H3/V2V/x', 'mp4', 'h264'], inputs: [{ name: 'video', link: 5 }] },
      { id: 11, type: 'MarkdownNote', widgets_values: ['note'] }
    ],
    links: [[1, 1, 0, 21, 0, 'MODEL'], [2, 21, 0, 5, 0, 'MODEL'], [3, 2, 0, 5, 1, 'CLIP'], [4, 5, 0, 6, 0, 'IMAGE'], [5, 6, 0, 7, 0, 'VIDEO']]
  }
}

const OBJECT_INFO = {
  UNETLoader: { input: { required: { unet_name: [['h3.safetensors']], weight_dtype: [['default']] } } },
  LoraLoaderModelOnly: { input: { required: { model: ['MODEL'], lora_name: [['style.safetensors']], strength_model: ['FLOAT'] } } },
  CLIPLoader: { input: { required: { clip_name: [['te.safetensors']], type: [['boogu']] }, optional: { device: [['default']] } } },
  MiniMaxH3Director: {
    input: {
      required: {
        model: ['MODEL'], clip: ['CLIP'], task_type: [[T2V, V2V]], global_prompt: ['STRING'], bd_grp_sample: ['BDGROUP'], cfg: ['FLOAT'],
        seed: ['INT', { control_after_generate: true }], frame_rate: ['FLOAT'], width: ['INT'], height: ['INT'], ref_max_size: ['INT'], total_frames: ['INT'], timeline_data: ['STRING']
      },
      optional: {
        bd_grp_advanced: ['BDGROUP'], steps: ['INT'], sampler: [['euler']], scheduler: [['simple']], shift_video: ['FLOAT'], shift_audio: ['FLOAT'],
        bd_grp_perf: ['BDGROUP'], clear_vram_between_segments: ['BOOLEAN'], export_source_images: ['BOOLEAN']
      }
    }
  },
  CreateVideo: { input: { required: { images: ['IMAGE'], fps: ['FLOAT'] } } },
  SaveVideo: { input: { required: { video: ['VIDEO'], filename_prefix: ['STRING'], format: [['mp4']], codec: [['h264']] } } },
  LoadVideo: { input: { required: { file: [['saved.mp4']] } } },
  CLIPTextEncode: { input: { required: { text: ['STRING'], clip: ['CLIP'] } } },
  KSampler: { input: { required: { model: ['MODEL'], seed: ['INT', { control_after_generate: true }], positive: ['CONDITIONING'] } } }
}

const genericVideoWorkflow = (loader) => ({
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'saved', clip: ['9', 0] } },
  '2': { class_type: 'KSampler', inputs: { positive: ['1', 0], seed: 1, model: ['9', 0] } },
  '3': { class_type: 'SaveVideo', inputs: { video: ['2', 0], filename_prefix: 'saved' } },
  ...(loader ? { '4': { class_type: loader, inputs: loader === 'LoadVideo' ? { file: 'saved.mp4' } : { image: 'saved.png' } } } : {})
})

class FakeSocket {
  static last = null
  constructor(url) {
    this.url = url
    this.listeners = {}
    FakeSocket.last = this
    setTimeout(() => {
      this.fire('open', {})
      setTimeout(() => {
        for (const message of [
          { type: 'execution_start', data: {} },
          { type: 'execution_cached', data: { nodes: ['1', '2'] } },
          { type: 'executing', data: { node: '5' } },
          { type: 'progress', data: { node: '5', value: 2, max: 4 } }
        ]) this.fire('message', { data: JSON.stringify(message) })
      }, 20)
    }, 5)
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  fire(type, event) { for (const fn of this.listeners[type] ?? []) fn(event) }
  close() { this.closed = true }
}

function comfyFixture(files, options = {}) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const href = String(url)
    calls.push({ href, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    if (href.endsWith('/system_stats')) return Response.json({ system: {} })
    if (href.includes('/api/userdata?dir=workflows')) return Response.json(Object.keys(files))
    const named = Object.keys(files).find((name) => href.endsWith(`/api/userdata/${encodeURIComponent(`workflows/${name}`)}`))
    if (named) return Response.json(files[named])
    if (href.includes('/object_info/')) {
      const type = decodeURIComponent(href.split('/object_info/')[1])
      return Response.json(OBJECT_INFO[type] ? { [type]: OBJECT_INFO[type] } : {})
    }
    if (href.endsWith('/upload/image')) return Response.json({ name: 'yan-1-clip.mp4' })
    if (href.endsWith('/minimax/director/probe_video')) return Response.json({ width: 1920, height: 1080, duration: 16, native_fps: 30, frame_count: 480 })
    if (href.endsWith('/prompt')) return Response.json({ prompt_id: 'pv' })
    if (href.endsWith('/queue') && init.method === 'POST') return Response.json({})
    if (href.endsWith('/queue')) return Response.json({ queue_running: [], queue_pending: [[3, 'other'], [4, 'pv']] })
    if (href.endsWith('/interrupt')) return Response.json({})
    if (href.includes('/history/pv')) {
      if (options.neverFinish) return Response.json({})
      return Response.json({ pv: { status: { completed: true }, outputs: { '7': { images: [{ filename: 'yan_00001.mp4', subfolder: 'Inkstone', type: 'output' }], animated: [true] }, '8': { text: ['report'] } } } })
    }
    if (href.includes('/view?')) return new Response(MP4)
    throw new Error('unexpected request ' + href)
  }
  return { calls, fetch }
}

export async function runComfyVideoTests() {
  let checks = 0
  const ok = (value, message) => { assert.ok(value, message); checks++ }
  const root = await mkdtemp(join(tmpdir(), 'inkstone-comfy-video-'))
  const originalFetch = globalThis.fetch
  const originalSocket = globalThis.WebSocket
  try {
    const project = join(root, 'project')
    const artifactDir = join(root, 'artifacts')
    await mkdir(project)
    await writeFile(join(project, 'clip.mp4'), MP4)
    await writeFile(join(project, 'notes.txt'), 'x')

    ok(classifyWorkflow(directorWorkflow()) === 'video-to-video', 'Director v2v workflow is video-to-video')
    ok(classifyWorkflow(directorWorkflow(T2V)) === 'text-to-video', 'Director t2v workflow is text-to-video')
    ok(classifyWorkflow(genericVideoWorkflow('LoadVideo')) === 'video-to-video', 'LoadVideo + SaveVideo is video-to-video')
    ok(classifyWorkflow(genericVideoWorkflow()) === 'text-to-video', 'SaveVideo without loaders is text-to-video')
    ok(classifyWorkflow(genericVideoWorkflow('LoadImage')) === 'image-to-video', 'LoadImage + SaveVideo is image-to-video')
    ok(classifyWorkflow({ ...genericVideoWorkflow(), '5': { class_type: 'SaveAudio', inputs: {} } }) === null, 'audio-only savers stay unsupported')

    const api = toApiPrompt(directorWorkflow(), OBJECT_INFO)
    const director = api['5'].inputs
    ok(director.bd_grp_sample === '采样设置' && director.cfg === 1 && director.seed === 5 && director.frame_rate === 24 && director.width === 384, 'custom BDGROUP widgets keep later widget values aligned')
    ok(director.steps === 4 && director.sampler === 'euler' && director.clear_vram_between_segments === true && typeof director.timeline_data === 'string', 'optional widgets after a BDGROUP stay aligned')
    ok(!api['11'] && api['21'].inputs.lora_name === 'style.safetensors', 'notes are dropped and LoRA settings are kept')

    await assert.rejects(loadVideoSource('notes.txt', { cwd: project, artifactDir }), { code: 'image_source_unsupported' }); checks++
    const video = await loadVideoSource('clip.mp4', { cwd: project, artifactDir })
    const server = { baseUrl: 'http://127.0.0.1:8188', name: 'ComfyUI' }

    globalThis.WebSocket = FakeSocket
    const fixture = comfyFixture({ '01_t2i.json': { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } }, '2': { class_type: 'KSampler', inputs: { positive: ['1', 0] } }, '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'p' } } }, '03_h3.json': directorWorkflow() })
    globalThis.fetch = fixture.fetch
    const progress = []
    const result = await comfyGenerate({ prompt: '红底上走路的蓝色小鱼' }, [], server, false, undefined, undefined, undefined, { media: 'video', video, onProgress: (patch) => progress.push(patch) })
    const posted = fixture.calls.find((call) => call.href.endsWith('/prompt')).body
    const timeline = JSON.parse(posted.prompt['5'].inputs.timeline_data)
    ok(result.model === '03_h3.json' && result.bytes.equals(MP4), 'video-to-video picks the Director workflow and downloads the mp4 output')
    ok(timeline.video.videoFile === 'yan-1-clip.mp4' && timeline.video.sourceFrameCount === 384 && timeline.totalFrames === 384, 'timeline points at the uploaded video with frames resampled to 24 fps')
    ok(timeline.output.maxExportFrames === 240 && timeline.output.width === 672 && timeline.output.height === 384 && posted.prompt['5'].inputs.width === 672, 'default 10 s cap and source-aspect size within the saved pixel budget')
    ok(timeline.global.prompt === '红底上走路的蓝色小鱼' && posted.prompt['5'].inputs.global_prompt === '红底上走路的蓝色小鱼', 'prompt goes to both the timeline and the widget')
    ok(posted.prompt['5'].inputs.seed !== 5 && posted.prompt['7'].inputs.filename_prefix === 'Inkstone/yan' && posted.prompt['21'].inputs.strength_model === 1, 'seed is randomized, SaveVideo is namespaced and LoRA strength is untouched')
    ok(FakeSocket.last.url === `ws://127.0.0.1:8188/ws?clientId=${posted.client_id}` && FakeSocket.last.closed, 'progress socket uses the submitted client id and is closed afterwards')
    const running = progress.find((patch) => patch.stage === 'running' && patch.steps === 4)
    ok(progress.some((patch) => patch.stage === 'uploading') && running?.nodeType === 'MiniMaxH3Director' && running.stepPercent === 50 && running.nodesDone === 2, 'progress reports stage, node type, cached nodes and step percent')

    const sized = comfyFixture({ '03_h3.json': directorWorkflow() })
    globalThis.fetch = sized.fetch
    await comfyGenerate({ prompt: 'x', size: '512x288', seconds: 4 }, [], server, false, undefined, undefined, undefined, { media: 'video', video })
    const sizedTimeline = JSON.parse(sized.calls.find((call) => call.href.endsWith('/prompt')).body.prompt['5'].inputs.timeline_data)
    ok(sizedTimeline.output.width === 512 && sizedTimeline.output.height === 288 && sizedTimeline.output.maxExportFrames === 96, 'explicit size and seconds are applied')

    const textOnly = comfyFixture({ '05_t2v.json': directorWorkflow(T2V) })
    globalThis.fetch = textOnly.fetch
    await comfyGenerate({ prompt: '红底上走路的蓝色小鱼', seconds: 6 }, [], server, false, undefined, undefined, undefined, { media: 'video' })
    const t2vTimeline = JSON.parse(textOnly.calls.find((call) => call.href.endsWith('/prompt')).body.prompt['5'].inputs.timeline_data)
    ok(t2vTimeline.timelineMode === 'gen_blank' && t2vTimeline.gen.defaultFrameCount === 144 && t2vTimeline.global.prompt === '红底上走路的蓝色小鱼' && !textOnly.calls.some((call) => call.href.includes('/upload/')), 'text-to-video switches a video timeline to generation mode and applies seconds without uploads')

    globalThis.WebSocket = undefined
    const generic = comfyFixture({ 'loadvideo.json': genericVideoWorkflow('LoadVideo') })
    globalThis.fetch = generic.fetch
    await comfyGenerate({ prompt: 'y' }, [], server, false, undefined, undefined, undefined, { media: 'video', video })
    const genericPosted = generic.calls.find((call) => call.href.endsWith('/prompt')).body.prompt
    ok(genericPosted['4'].inputs.file === 'yan-1-clip.mp4' && genericPosted['1'].inputs.text === 'y' && !generic.calls.some((call) => call.href.includes('probe_video')), 'generic LoadVideo is rewired without the Director probe')

    const mismatch = comfyFixture({ '01_t2i.json': { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } }, '2': { class_type: 'KSampler', inputs: { positive: ['1', 0] } }, '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'p' } } } })
    globalThis.fetch = mismatch.fetch
    await assert.rejects(
      comfyGenerate({ prompt: 'z', model: '01_t2i' }, [], server, false, undefined, undefined, undefined, { media: 'video', video }),
      (error) => error.code === 'local_workflow_missing' && /文生图/.test(error.message) && /视频转视频/.test(error.message)
    ); checks++

    globalThis.WebSocket = FakeSocket
    const jobFixture = comfyFixture({ '03_h3.json': directorWorkflow() })
    globalThis.fetch = jobFixture.fetch
    const service = createComfyService({ artifactDir, confirm: async () => false })
    const started = await service('video', { input: { prompt: '小鱼', videoPath: 'clip.mp4', detach: true }, context: { cwd: project } })
    ok(started.state === 'running' && typeof started.jobId === 'string' && started.media === 'video', 'detached video request returns a running job immediately')
    const finished = await service('job', { input: { jobId: started.jobId, waitSeconds: 20 } })
    ok(finished.state === 'done' && finished.mimeType === 'video/mp4' && (await readFile(finished.path)).equals(MP4) && finished.workflow === '03_h3.json', 'waiting on the job returns the saved video')
    const listed = await service('status', {})
    ok(listed.jobs.some((job) => job.jobId === started.jobId && job.state === 'done'), 'status lists recent jobs')

    const stuck = comfyFixture({ '03_h3.json': directorWorkflow() }, { neverFinish: true })
    globalThis.fetch = stuck.fetch
    const slow = await service('video', { input: { prompt: '小鱼', videoPath: 'clip.mp4', detach: true }, context: { cwd: project } })
    const midway = await service('job', { input: { jobId: slow.jobId, waitSeconds: 4 } })
    ok(midway.state === 'running' && midway.stage === 'running' && midway.steps === 4 && midway.elapsedSeconds >= 3, 'an unfinished job reports live progress after the wait budget')
    const cancelled = await service('job', { input: { jobId: slow.jobId, cancel: true } })
    ok(cancelled.state === 'cancelled' && stuck.calls.some((call) => call.href.endsWith('/queue') && call.init.method === 'POST' && call.body.delete[0] === 'pv'), 'cancelling a job removes its queued ComfyUI prompt')
    await assert.rejects(service('job', { input: { jobId: 'missing' } }), /任务不存在/); checks++
  } finally {
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalSocket
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  console.log(`comfyui-video: ${checks} checks passed (fixture only; no ComfyUI/model process)`)
  return checks
}
