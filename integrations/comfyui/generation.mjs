import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fetchComfyWorkflow, listComfyWorkflows } from './discovery.mjs';
import { applyRequest, toApiPrompt, usesApiNodes, workflowNodeTypes, WorkflowError } from './workflow.mjs';
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
const MAX_SOURCES = 4;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
function inside(root, path) {
    const rel = relative(resolve(root), path);
    return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function loadSources(paths, roots) {
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
        const mime = SOURCE_MIME[extname(path).toLowerCase()];
        if (!mime)
            throw new ImageProviderError('image_source_unsupported', raw);
        const info = await stat(source).catch(() => null);
        if (!info?.isFile())
            throw new ImageProviderError('image_source_missing', raw);
        if (info.size > MAX_SOURCE_BYTES)
            throw new ImageProviderError('image_source_too_large', raw);
        out.push({ name: path.split(/[\\/]/).pop() ?? 'source', mime, bytes: await readFile(source) });
    }
    return out;
}
const LOCAL_TIMEOUT_MS = 15 * 60_000;
export function comfyAbortRequests(promptId, managed) {
    return [
        ...(managed ? [{ path: '/interrupt', body: '{}' }] : []),
        { path: '/queue', body: JSON.stringify({ delete: [promptId] }) }
    ];
}
export function comfyCandidates(entries, wanted, edit) {
    const normalize = (name) => name.toLowerCase().replace(/\.json$/, '').replace(/^.*\//, '');
    const named = wanted || process.env.YAN_COMFYUI_WORKFLOW?.trim() || '';
    if (named) {
        const hit = entries.find((entry) => entry.name === named || normalize(entry.name) === normalize(named));
        if (hit)
            return [hit];
    }
    return entries.filter((entry) => entry.kind === (edit ? 'image-to-image' : 'text-to-image'));
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
            return { prompt: applyRequest(converted, { ...request, filenamePrefix: 'Inkstone/yan' }), workflow: candidate.name };
        }
        catch (error) {
            checkImageCancelled(signal);
            problems.push(`${candidate.name}：${error instanceof WorkflowError ? error.reason ?? error.code : error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new ImageProviderError(candidates.length ? 'local_workflow_unsupported' : 'local_workflow_missing', problems.slice(0, 3).join('；') || undefined);
}
async function comfyImage(req, sources, server, managed, report, signal, confirmCloudNodes) {
    const entries = await waitForImage(listComfyWorkflows(server.baseUrl).catch(() => []), signal);
    const wanted = stringParam(req.model, '');
    const candidates = comfyCandidates(entries, wanted, sources.length > 0);
    const requestedWorkflow = wanted || process.env.YAN_COMFYUI_WORKFLOW?.trim() || '';
    const namedHit = !!requestedWorkflow && candidates.length === 1 && entries.some((entry) => entry.name === candidates[0].name && (entry.name === requestedWorkflow || entry.name.toLowerCase().replace(/\.json$/, '').split('/').at(-1) === requestedWorkflow.toLowerCase().replace(/\.json$/, '').split('/').at(-1)));
    if (!candidates.length) {
        throw new ImageProviderError('local_workflow_missing', sources.length ? '没有可用的图生图工作流（含 LoadImage）' : '没有可用的文生图工作流');
    }
    report?.('requesting', `${server.name} · ${candidates[0].name}`);
    const images = [];
    for (const source of sources)
        images.push(await comfyUpload(server, source, signal));
    const size = parseSize(req.size);
    const built = await buildComfyPrompt(server, candidates, namedHit, {
        prompt: req.prompt,
        ...(size ? { width: size.width, height: size.height } : {}),
        ...(images.length ? { images } : {})
    }, signal, confirmCloudNodes);
    checkImageCancelled(signal);
    const prompt = built.prompt;
    const chosen = { name: built.workflow };
    const queued = await fetch(`${server.baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, client_id: `yan-${randomUUID()}` }),
        signal: imageSignal(30_000, signal)
    });
    if (!queued.ok)
        throw await httpError('local', queued);
    const promptId = (await queued.json()).prompt_id;
    if (!promptId)
        throw new ImageProviderError('local_image_result_missing');
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
        const deadline = Date.now() + LOCAL_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await delay(1_000, undefined, { signal });
            checkImageCancelled(signal);
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
            const outputs = Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? []);
            const image = outputs.find((item) => item.type === 'output') ?? outputs[0];
            if (!image) {
                if (entry.status?.completed)
                    throw new ImageProviderError('local_image_result_missing');
                continue;
            }
            const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
            const file = await fetch(`${server.baseUrl}/view?${query}`, { signal: imageSignal(30_000, signal) });
            if (!file.ok)
                throw await httpError('local', file);
            return { bytes: Buffer.from(await file.arrayBuffer()), model: chosen.name };
        }
        abortPrompt();
        throw new ImageProviderError('local_timeout');
    }
    finally {
        signal?.removeEventListener('abort', abortPrompt);
    }
}
export { comfyImage, loadSources, sniffFormat };
