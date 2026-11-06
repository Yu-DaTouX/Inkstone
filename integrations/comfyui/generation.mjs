import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fetchComfyWorkflow, listComfyWorkflows } from './discovery.mjs';
import { applyRequest, toApiPrompt, usesApiNodes, usesDirector, workflowNodeTypes, WorkflowError } from './workflow.mjs';
function stringParam(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
function formatOf(value) {
    const v = String(value ?? 'png').toLowerCase();
    return v === 'jpeg' || v === 'jpg' ? 'jpeg' : v === 'webp' ? 'webp' : 'png';
}
function sniffFormat(bytes) {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return 'png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return 'jpeg';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
        return 'webp';
    return undefined;
}
function sniffVideoFormat(bytes) {
    if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp')
        return bytes.toString('ascii', 8, 10) === 'qt' ? 'mov' : 'mp4';
    if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3)
        return 'webm';
    if (bytes.length >= 6 && bytes.toString('ascii', 0, 4) === 'GIF8')
        return 'gif';
    return sniffFormat(bytes) === 'webp' ? 'webp' : undefined;
}
const VIDEO_MIME = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', gif: 'image/gif', webp: 'image/webp' };
function parseSize(size) {
    const match = typeof size === 'string' ? /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(size.trim()) : null;
    if (!match)
        return undefined;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? { width, height } : undefined;
}
async function errorReason(response) {
    const text = await response.text().catch(() => '');
    try {
        const json = JSON.parse(text);
        const message = typeof json.error === 'string' ? json.error : json.error?.message ?? json.message ?? json.detail;
        if (typeof message === 'string' && message.trim())
            return message.trim().slice(0, 200);
    }
    catch {
    }
    return `HTTP ${response.status}：服务未返回可读错误信息`;
}
class ImageProviderError extends Error {
    code;
    reason;
    constructor(code, reason) {
        super(reason ? `${code}: ${reason}` : code);
        this.code = code;
        this.reason = reason;
    }
}
async function responseJson(response, prefix) {
    try {
        return await response.json();
    }
    catch {
        throw new ImageProviderError(`${prefix}_invalid_response`, `HTTP ${response.status}：响应不是有效 JSON`);
    }
}
async function httpError(prefix, response) {
    const reason = await errorReason(response);
    if (response.status === 401 || response.status === 403)
        return new ImageProviderError(`${prefix}_auth_rejected`, reason);
    if (response.status === 429)
        return new ImageProviderError(`${prefix}_rate_limited`, reason);
    return new ImageProviderError(`${prefix}_http_${response.status}`, reason);
}
const REQUEST_TIMEOUT_MS = 6 * 60_000;
function imageSignal(timeoutMs, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export function waitForImage(pending, signal) {
    if (!signal)
        return pending;
    return new Promise((resolve, reject) => {
        const cancel = () => reject(new ImageProviderError('image_cancelled'));
        if (signal.aborted) {
            void pending.catch(() => undefined);
            cancel();
            return;
        }
        signal.addEventListener('abort', cancel, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel)).catch(() => undefined);
    });
}
function checkImageCancelled(signal) {
    if (signal?.aborted)
        throw new ImageProviderError('image_cancelled');
}
const SOURCE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const VIDEO_SOURCE_MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
const MAX_SOURCES = 4;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_SOURCE_BYTES = 500 * 1024 * 1024;
function inside(root, path) {
    const rel = relative(resolve(root), path);
    return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function loadSources(paths, roots, limits = { mime: SOURCE_MIME, maxBytes: MAX_SOURCE_BYTES }) {
    if (!paths?.length)
        return [];
    if (paths.length > MAX_SOURCES)
        throw new ImageProviderError('image_source_too_many', `最多 ${MAX_SOURCES} 张参考图`);
    const allowedRoots = await Promise.all([roots.cwd, roots.artifactDir]
        .filter((root) => !!root)
        .map((root) => realpath(root).catch(() => null)));
    const out = [];
    for (const raw of paths) {
        const path = resolve(roots.cwd ?? roots.artifactDir, raw);
        if (!(roots.cwd && inside(roots.cwd, path)) && !inside(roots.artifactDir, path)) {
            throw new ImageProviderError('image_source_outside_project', raw);
        }
        const source = await realpath(path).catch(() => null);
        if (!source)
            throw new ImageProviderError('image_source_missing', raw);
        if (!allowedRoots.some((root) => root && inside(root, source))) {
            throw new ImageProviderError('image_source_outside_project', raw);
        }
        const mime = limits.mime[extname(path).toLowerCase()];
        if (!mime)
            throw new ImageProviderError('image_source_unsupported', raw);
        const info = await stat(source).catch(() => null);
        if (!info?.isFile())
            throw new ImageProviderError('image_source_missing', raw);
        if (info.size > limits.maxBytes)
            throw new ImageProviderError('image_source_too_large', raw);
        out.push({ name: path.split(/[\\/]/).pop() ?? 'source', mime, bytes: await readFile(source) });
    }
    return out;
}
async function loadVideoSource(path, roots) {
    if (path === undefined)
        return undefined;
    const [video] = await loadSources([path], roots, { mime: VIDEO_SOURCE_MIME, maxBytes: MAX_VIDEO_SOURCE_BYTES });
    return video;
}
const LOCAL_TIMEOUT_MS = 15 * 60_000;
const LOCAL_VIDEO_TIMEOUT_MS = 40 * 60_000;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|gif|webp)$/i;
export function comfyAbortRequests(promptId, managed) {
    return [
        ...(managed ? [{ path: '/interrupt', body: '{}' }] : []),
        { path: '/queue', body: JSON.stringify({ delete: [promptId] }) }
    ];
}
export function requestedKind(media, sources, video) {
    if (media !== 'video')
        return sources.length ? 'image-to-image' : 'text-to-image';
    return video ? 'video-to-video' : sources.length ? 'image-to-video' : 'text-to-video';
}
function compatibleKind(entryKind, kind) {
    if (entryKind === kind)
        return true;
    return entryKind.split('-to-')[1] === kind.split('-to-')[1] && kind !== 'video-to-video' && entryKind !== 'video-to-video';
}
export function comfyCandidates(entries, wanted, kind) {
    const normalize = (name) => name.toLowerCase().replace(/\.json$/, '').replace(/^.*\//, '');
    const named = wanted || (kind.endsWith('-image') ? process.env.YAN_COMFYUI_WORKFLOW?.trim() : '') || '';
    if (named) {
        const hit = entries.find((entry) => compatibleKind(entry.kind, kind) && (entry.name === named || normalize(entry.name) === normalize(named)));
        if (hit)
            return [hit];
        if (wanted && entries.some((entry) => entry.name === named || normalize(entry.name) === normalize(named)))
            return [];
    }
    return entries.filter((entry) => entry.kind === kind);
}
const KIND_LABEL = { 'text-to-image': '文生图', 'image-to-image': '图生图（含 LoadImage）', 'text-to-video': '文生视频', 'image-to-video': '图生视频', 'video-to-video': '视频转视频' };
async function probeDirectorVideo(server, name, signal) {
    const response = await fetch(`${server.baseUrl}/minimax/director/probe_video`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoFile: name, subfolder: '', type: 'input' }), signal: imageSignal(60_000, signal)
    }).catch(() => null);
    if (!response?.ok)
        return null;
    const info = await response.json().catch(() => null);
    const duration = Number(info?.duration) || (Number(info?.frame_count) && Number(info?.native_fps) ? Number(info.frame_count) / Number(info.native_fps) : 0);
    return duration > 0 ? { width: Number(info.width) || 0, height: Number(info.height) || 0, duration, fps: Number(info.native_fps) || 0 } : null;
}
async function comfyUpload(server, source, signal) {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(source.bytes)], { type: source.mime }), `yan-${randomUUID().slice(0, 8)}-${source.name}`);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const response = await fetch(`${server.baseUrl}/upload/image`, { method: 'POST', body: form, signal: imageSignal(60_000, signal) });
    if (!response.ok)
        throw await httpError('local', response);
    const json = (await response.json());
    if (!json.name)
        throw new ImageProviderError('local_upload_failed');
    return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
}
async function comfyObjectInfo(server, types, cache, signal) {
    for (const type of types) {
        if (cache[type])
            continue;
        checkImageCancelled(signal);
        const response = await fetch(`${server.baseUrl}/object_info/${encodeURIComponent(type)}`, { signal: imageSignal(10_000, signal) }).catch(() => null);
        if (!response?.ok)
            continue;
        const entry = (await response.json().catch(() => ({})))[type];
        if (entry)
            cache[type] = entry;
    }
    return cache;
}
async function buildComfyPrompt(server, candidates, named, request, signal, confirmCloudNodes) {
    const cache = {};
    const problems = [];
    for (const candidate of candidates) {
        try {
            checkImageCancelled(signal);
            const workflow = (await waitForImage(fetchComfyWorkflow(server.baseUrl, candidate.name), signal));
            const info = await comfyObjectInfo(server, workflowNodeTypes(workflow), cache, signal);
            const converted = toApiPrompt(workflow, info);
            if (usesApiNodes(converted, info) && !(named && confirmCloudNodes && await waitForImage(confirmCloudNodes(candidate.name), signal))) {
                problems.push(`${candidate.name}：用到 ComfyUI 云端 API 节点${named ? '，未获得确认' : ''}`);
                continue;
            }
            const video = request.video && usesDirector(converted) ? await request.probe() : request.video;
            if (request.video && !video)
                throw new WorkflowError('local_workflow_unsupported', 'MiniMax H3 Director 探测不到源视频，确认 ComfyUI_MiniMaxH3_Director 已加载');
            return { prompt: applyRequest(converted, { ...request, video, filenamePrefix: 'Inkstone/yan' }), workflow: candidate.name };
        }
        catch (error) {
            checkImageCancelled(signal);
            problems.push(`${candidate.name}：${error instanceof WorkflowError ? error.reason ?? error.code : error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new ImageProviderError(candidates.length ? 'local_workflow_unsupported' : 'local_workflow_missing', problems.slice(0, 3).join('；') || undefined);
}
async function watchComfyProgress(server, clientId, prompt, onProgress) {
    const state = { started: false, done: new Set(), node: undefined, step: undefined, steps: undefined };
    const total = Object.keys(prompt).length;
    const emit = (extra = {}) => onProgress?.({
        stage: state.started ? 'running' : 'queued',
        nodesDone: Math.min(state.done.size, total), nodesTotal: total,
        node: state.node, nodeType: state.node ? prompt[state.node]?.class_type : undefined,
        step: state.steps ? state.step : undefined, steps: state.steps || undefined,
        stepPercent: state.steps ? Math.round((state.step / state.steps) * 100) : undefined,
        queuePosition: undefined,
        ...extra
    });
    let socket = null;
    if (onProgress && typeof globalThis.WebSocket === 'function') {
        try {
            socket = new globalThis.WebSocket(`${server.baseUrl.replace(/^http/i, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`);
            socket.addEventListener('message', (event) => {
                if (typeof event.data !== 'string')
                    return;
                let message;
                try {
                    message = JSON.parse(event.data);
                }
                catch {
                    return;
                }
                const data = message?.data ?? {};
                if (message?.type === 'execution_start') {
                    state.started = true;
                }
                else if (message?.type === 'execution_cached') {
                    for (const id of data.nodes ?? [])
                        state.done.add(String(id));
                }
                else if (message?.type === 'executing') {
                    state.started = true;
                    if (state.node)
                        state.done.add(state.node);
                    state.node = data.node == null ? undefined : String(data.node);
                    state.step = state.steps = undefined;
                }
                else if (message?.type === 'progress') {
                    state.started = true;
                    state.step = Number(data.value) || 0;
                    state.steps = Number(data.max) || 0;
                    if (data.node != null)
                        state.node = String(data.node);
                }
                else {
                    return;
                }
                emit();
            });
            socket.addEventListener('error', () => undefined);
            await new Promise((resolve) => {
                socket.addEventListener('open', resolve, { once: true });
                socket.addEventListener('error', resolve, { once: true });
                setTimeout(resolve, 2_000).unref?.();
            });
        }
        catch {
            socket = null;
        }
    }
    return {
        get started() { return state.started; },
        queued(position, running) {
            if (state.started)
                return;
            if (running) {
                state.started = true;
                emit();
            }
            else {
                emit({ queuePosition: position });
            }
        },
        close() {
            try {
                socket?.close();
            }
            catch {
            }
        }
    };
}
async function queuePosition(server, promptId, signal) {
    const response = await fetch(`${server.baseUrl}/queue`, { signal: imageSignal(5_000, signal) }).catch(() => null);
    const queue = response?.ok ? await response.json().catch(() => null) : null;
    if (!queue)
        return null;
    const idOf = (item) => (Array.isArray(item) ? item[1] : undefined);
    if ((queue.queue_running ?? []).some((item) => idOf(item) === promptId))
        return { running: true };
    const pending = [...(queue.queue_pending ?? [])].sort((a, b) => Number(a?.[0]) - Number(b?.[0]));
    const index = pending.findIndex((item) => idOf(item) === promptId);
    return index >= 0 ? { running: false, position: index + 1 + (queue.queue_running ?? []).length } : null;
}
async function comfyGenerate(req, sources, server, managed, report, signal, confirmCloudNodes, options = {}) {
    const media = options.media === 'video' ? 'video' : 'image';
    const kind = requestedKind(media, sources, options.video);
    const entries = await waitForImage(listComfyWorkflows(server.baseUrl).catch(() => []), signal);
    const wanted = stringParam(req.model, '');
    const candidates = comfyCandidates(entries, wanted, kind);
    const requestedWorkflow = wanted || (media === 'image' ? process.env.YAN_COMFYUI_WORKFLOW?.trim() : '') || '';
    const namedHit = !!requestedWorkflow && candidates.length === 1 && entries.some((entry) => entry.name === candidates[0].name && (entry.name === requestedWorkflow || entry.name.toLowerCase().replace(/\.json$/, '').split('/').at(-1) === requestedWorkflow.toLowerCase().replace(/\.json$/, '').split('/').at(-1)));
    if (!candidates.length) {
        const named = wanted ? entries.find((entry) => entry.name === wanted || entry.name.toLowerCase().replace(/\.json$/, '').split('/').at(-1) === wanted.toLowerCase().replace(/\.json$/, '').split('/').at(-1)) : undefined;
        throw new ImageProviderError('local_workflow_missing', named ? `${named.name} 是${KIND_LABEL[named.kind]}工作流，这次需要${KIND_LABEL[kind]}` : `没有可用的${KIND_LABEL[kind]}工作流`);
    }
    report?.('requesting', `${server.name} · ${candidates[0].name}`);
    options.onProgress?.({ stage: 'uploading', workflow: candidates[0].name });
    const images = [];
    for (const source of sources)
        images.push(await comfyUpload(server, source, signal));
    const videoName = options.video ? await comfyUpload(server, options.video, signal) : undefined;
    const size = parseSize(req.size);
    const built = await buildComfyPrompt(server, candidates, namedHit, {
        prompt: req.prompt,
        ...(size ? { width: size.width, height: size.height } : {}),
        ...(images.length ? { images } : {}),
        ...(videoName ? { video: { name: videoName }, probe: async () => {
                const info = await probeDirectorVideo(server, videoName, signal);
                return info ? { name: videoName, ...info } : null;
            } } : {}),
        ...(req.seconds ? { seconds: req.seconds } : {})
    }, signal, confirmCloudNodes);
    checkImageCancelled(signal);
    const prompt = built.prompt;
    const chosen = { name: built.workflow };
    options.onProgress?.({ stage: 'submitting', workflow: chosen.name });
    const clientId = `yan-${randomUUID()}`;
    const watcher = await watchComfyProgress(server, clientId, prompt, options.onProgress);
    let queued;
    try {
        queued = await fetch(`${server.baseUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, client_id: clientId }),
            signal: imageSignal(30_000, signal)
        });
    }
    catch (error) {
        watcher.close();
        throw error;
    }
    if (!queued.ok) {
        watcher.close();
        throw await httpError('local', queued);
    }
    const promptId = (await queued.json()).prompt_id;
    if (!promptId) {
        watcher.close();
        throw new ImageProviderError('local_image_result_missing');
    }
    const abortPrompt = () => {
        for (const request of comfyAbortRequests(promptId, managed)) {
            void fetch(`${server.baseUrl}${request.path}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: request.body, signal: AbortSignal.timeout(5_000)
            }).catch(() => undefined);
        }
    };
    signal?.addEventListener('abort', abortPrompt, { once: true });
    try {
        if (signal?.aborted) {
            abortPrompt();
            checkImageCancelled(signal);
        }
        report?.('generating', `${server.name} · ${chosen.name}`);
        const deadline = Date.now() + (media === 'video' ? LOCAL_VIDEO_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
        for (let tick = 0; Date.now() < deadline; tick++) {
            await delay(1_000, undefined, { signal });
            checkImageCancelled(signal);
            if (options.onProgress && !watcher.started && tick % 3 === 0) {
                const place = await queuePosition(server, promptId, signal);
                if (place)
                    watcher.queued(place.position, place.running);
            }
            const history = await fetch(`${server.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal: imageSignal(10_000, signal) }).catch(() => null);
            checkImageCancelled(signal);
            if (!history?.ok)
                continue;
            const entry = (await history.json())[promptId];
            if (!entry)
                continue;
            if (entry.status?.status_str === 'error') {
                const failed = entry.status.messages?.find(([kind]) => kind === 'execution_error')?.[1]?.exception_message;
                throw new ImageProviderError('local_workflow_failed', failed?.slice(0, 200));
            }
            const outputs = Object.values(entry.outputs ?? {})
                .flatMap((output) => [...(output.images ?? []), ...(output.gifs ?? []), ...(output.videos ?? [])])
                .filter((item) => typeof item?.filename === 'string' && (media === 'video' ? VIDEO_EXT : IMAGE_EXT).test(item.filename));
            const image = outputs.find((item) => item.type === 'output') ?? outputs[0];
            if (!image) {
                if (entry.status?.completed)
                    throw new ImageProviderError('local_image_result_missing', media === 'video' ? '工作流完成但没有视频输出' : undefined);
                continue;
            }
            options.onProgress?.({ stage: 'downloading', node: undefined, nodeType: undefined, step: undefined, steps: undefined, stepPercent: undefined });
            const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
            const file = await fetch(`${server.baseUrl}/view?${query}`, { signal: imageSignal(media === 'video' ? 300_000 : 30_000, signal) });
            if (!file.ok)
                throw await httpError('local', file);
            return { bytes: Buffer.from(await file.arrayBuffer()), model: chosen.name };
        }
        abortPrompt();
        throw new ImageProviderError('local_timeout');
    }
    finally {
        watcher.close();
        signal?.removeEventListener('abort', abortPrompt);
    }
}
const comfyImage = (req, sources, server, managed, report, signal, confirmCloudNodes) => comfyGenerate(req, sources, server, managed, report, signal, confirmCloudNodes);
export { comfyGenerate, comfyImage, loadSources, loadVideoSource, sniffFormat, sniffVideoFormat, VIDEO_MIME, watchComfyProgress, queuePosition, comfyUpload, httpError, imageSignal, ImageProviderError, inside, SOURCE_MIME, VIDEO_SOURCE_MIME };
