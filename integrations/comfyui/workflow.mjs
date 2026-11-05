const FRONTEND_ONLY = new Set(['Note', 'MarkdownNote', 'PrimitiveNode', 'Reroute', 'Label (rgthree)', 'Fast Groups Muter (rgthree)', 'Fast Groups Bypasser (rgthree)']);
const LOADS_MEDIA = /LoadImage|ImageFolder|LoadVideo|VHS_Load|LoadAudio|Load3D/i;
const LOADS_SINGLE_IMAGE = /^LoadImage(Output|Mask)?$/;
const LOADS_VIDEO = /^LoadVideo$|^VHS_LoadVideo(FFmpeg)?$/;
const SAVES_IMAGE = /^SaveImage|SaveImage$|^Image Save$/;
const SAVES_VIDEO = /SaveVideo|SaveAnimated|SaveWEBM|VHS_VideoCombine/i;
const SAVES_UNSUPPORTED = /SaveAudio|Save3D|SaveGLB/i;
const DIRECTOR = 'MiniMaxH3Director';
const DIRECTOR_DEFAULT_SECONDS = 10;
const DIRECTOR_MAX_SECONDS = 30;
const SAMPLES = /Sampler|Guider|Sample|Director/i;
const ENCODES_TEXT = /TextEncode|CLIPText|Prompt|Director/i;
const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize']);
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
export class WorkflowError extends Error {
    code;
    reason;
    constructor(code, reason) {
        super(reason ? `${code}: ${reason}` : code);
        this.code = code;
        this.reason = reason;
    }
}
export function isApiPrompt(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || 'nodes' in value)
        return false;
    const entries = Object.values(value);
    return entries.length > 0 && entries.every((node) => !!node && typeof node === 'object' && typeof node.class_type === 'string');
}
function collectSubgraphs(workflow) {
    const out = new Map();
    const visit = (list) => {
        for (const sub of list ?? []) {
            if (!sub?.id || out.has(sub.id))
                continue;
            out.set(sub.id, sub);
            visit(sub.definitions?.subgraphs);
        }
    };
    visit(workflow.definitions?.subgraphs);
    return out;
}
function activeNodes(workflow) {
    if (isApiPrompt(workflow))
        return Object.values(workflow).map((node) => ({ type: node.class_type, values: [node.inputs?.task_type, node.inputs?.timeline_data] }));
    const subgraphs = collectSubgraphs(workflow);
    const out = [];
    const walk = (nodes, depth) => {
        for (const node of nodes ?? []) {
            if (node.mode === 2 || node.mode === 4 || FRONTEND_ONLY.has(node.type))
                continue;
            const sub = subgraphs.get(node.type);
            if (sub) {
                if (depth < 8)
                    walk(sub.nodes, depth + 1);
            }
            else {
                const values = node.widgets_values;
                out.push({ type: node.type, values: Array.isArray(values) ? values : Object.values(values ?? {}) });
            }
        }
    };
    walk(workflow.nodes, 0);
    return out;
}
function activeTypes(workflow) {
    return activeNodes(workflow).map((node) => node.type);
}
function taskKey(value) {
    return String(value ?? '').split(/\s+[—–-]+\s+/)[0].trim().toLowerCase();
}
function directorTask(values) {
    let widget = '';
    for (const value of values) {
        if (typeof value !== 'string')
            continue;
        if (value.trim().startsWith('{')) {
            try {
                const task = JSON.parse(value)?.global?.taskType;
                if (typeof task === 'string' && task.trim())
                    return taskKey(task);
            }
            catch {
            }
        }
        else if (!widget && /^\s*[a-z0-9]+\s+[—–-]+\s+/i.test(value)) {
            widget = value;
        }
    }
    return taskKey(widget);
}
export function classifyWorkflow(workflow) {
    const nodes = activeNodes(workflow);
    const types = nodes.map((node) => node.type);
    if (types.some((type) => type.startsWith('workflow>') || type.startsWith('workflow/') || SAVES_UNSUPPORTED.test(type)))
        return null;
    if (!types.some((type) => SAMPLES.test(type)) || !types.some((type) => ENCODES_TEXT.test(type)))
        return null;
    const video = types.some((type) => SAVES_VIDEO.test(type));
    if (!video && !types.some((type) => SAVES_IMAGE.test(type)))
        return null;
    const loads = types.filter((type) => LOADS_MEDIA.test(type));
    if (!video) {
        if (!loads.length)
            return 'text-to-image';
        return loads.every((type) => LOADS_SINGLE_IMAGE.test(type)) ? 'image-to-image' : null;
    }
    const director = nodes.find((node) => node.type === DIRECTOR);
    if (director) {
        if (loads.length)
            return null;
        const task = directorTask(director.values);
        return task === 'v2v' || task === 'rv2v' ? 'video-to-video' : task === 't2v' ? 'text-to-video' : null;
    }
    if (!loads.length)
        return 'text-to-video';
    if (loads.length === 1 && LOADS_VIDEO.test(loads[0]))
        return 'video-to-video';
    return loads.every((type) => LOADS_SINGLE_IMAGE.test(type)) ? 'image-to-video' : null;
}
export function usesDirector(prompt) {
    return Object.values(prompt).some((node) => node.class_type === DIRECTOR);
}
function snap32(value) {
    return Math.max(256, Math.round(value / 32) * 32);
}
function fitAspect(width, height, aspect) {
    const area = Math.max(1, width) * Math.max(1, height);
    const w = Math.sqrt(area * aspect);
    return [snap32(w), snap32(w / aspect)];
}
function patchDirector(node, request) {
    let timeline = {};
    try {
        timeline = JSON.parse(typeof node.inputs.timeline_data === 'string' && node.inputs.timeline_data.trim() ? node.inputs.timeline_data : '{}') ?? {};
    }
    catch {
        throw new WorkflowError('local_workflow_unsupported', 'MiniMax H3 Director 的 timeline_data 不是有效 JSON');
    }
    const fps = Number(timeline.frameRate || node.inputs.frame_rate || 24) || 24;
    const output = { ...(timeline.output ?? {}) };
    let width = Number(output.width || timeline.width || node.inputs.width || 384);
    let height = Number(output.height || timeline.height || node.inputs.height || 672);
    if (request.width && request.height)
        [width, height] = [snap32(request.width), snap32(request.height)];
    else if (request.video?.width && request.video?.height)
        [width, height] = fitAspect(width, height, request.video.width / request.video.height);
    Object.assign(output, { mode: 'fixed', aspectRatio: '自定义', width, height, longEdge: Math.max(width, height) });
    const seconds = Math.min(Math.max(Number(request.seconds) || DIRECTOR_DEFAULT_SECONDS, 1), DIRECTOR_MAX_SECONDS);
    const next = { ...timeline, width, height, output, global: { ...(timeline.global ?? {}), prompt: request.prompt } };
    if (request.video) {
        const duration = Number(request.video.duration) || 0;
        if (duration <= 0)
            throw new WorkflowError('local_workflow_unsupported', '无法读取源视频时长');
        const sourceFrames = Math.max(1, Math.round(duration * fps));
        output.maxExportFrames = Math.min(sourceFrames, Math.round(seconds * fps));
        Object.assign(next, {
            editMode: 'global', timelineMode: 'video', totalFrames: sourceFrames, videoClips: [], segments: [], splitPoints: [], runSelectEnabled: false, runSelection: [],
            video: {
                ...(timeline.video ?? {}),
                fileName: request.video.name.split('/').pop(), videoFile: request.video.name, subfolder: '', type: 'input',
                frames: [], frameMap: [], deletedSourceRanges: [], sourceFrameCount: sourceFrames,
                width: request.video.width, height: request.video.height, duration, nativeFps: request.video.fps || null,
                storageWidth: width, storageHeight: height
            }
        });
    }
    else {
        if (String(timeline.timelineMode ?? '').toLowerCase() === 'video')
            next.timelineMode = 'gen_blank';
        if (request.seconds)
            next.gen = { ...(timeline.gen ?? {}), defaultFrameCount: Math.round(seconds * fps) };
    }
    node.inputs.timeline_data = JSON.stringify(next);
    node.inputs.width = width;
    node.inputs.height = height;
    if (typeof node.inputs.global_prompt === 'string')
        node.inputs.global_prompt = request.prompt;
}
export function workflowNodeTypes(workflow) {
    return [...new Set(activeTypes(workflow))];
}
function linkTable(links) {
    const table = new Map();
    for (const link of links ?? []) {
        if (Array.isArray(link))
            table.set(Number(link[0]), { from: Number(link[1]), slot: Number(link[2]), to: Number(link[3]), toSlot: Number(link[4]), type: typeof link[5] === 'string' ? link[5] : undefined });
        else if (link && typeof link === 'object')
            table.set(Number(link.id), { from: Number(link.origin_id), slot: Number(link.origin_slot), to: Number(link.target_id), toSlot: Number(link.target_slot), type: link.type });
    }
    return table;
}
function isWidgetSpec(spec) {
    const type = spec?.[0];
    return Array.isArray(type) || (typeof type === 'string' && WIDGET_TYPES.has(type));
}
function widgetOrder(info, node) {
    if (info?.input) {
        const entries = [...Object.entries(info.input.required ?? {}), ...Object.entries(info.input.optional ?? {})];
        const uiWidgets = new Set((node.inputs ?? []).filter((input) => input.widget).map((input) => input.widget?.name ?? input.name));
        return entries
            .filter(([name, spec]) => isWidgetSpec(spec) || uiWidgets.has(name))
            .map(([name, spec]) => {
            const options = (spec[1] ?? {});
            return { name, control: options.control_after_generate === true || (spec[0] === 'INT' && (name === 'seed' || name === 'noise_seed')) };
        });
    }
    return (node.inputs ?? [])
        .filter((input) => input.widget)
        .map((input) => ({ name: input.widget?.name ?? input.name, control: input.name === 'seed' || input.name === 'noise_seed' }));
}
function widgetValues(node, info) {
    const inputs = {};
    const values = node.widgets_values;
    const order = widgetOrder(info, node);
    if (Array.isArray(values)) {
        let index = 0;
        for (const widget of order) {
            if (index >= values.length)
                break;
            inputs[widget.name] = values[index++];
            if (widget.control && typeof values[index] === 'string' && CONTROL_VALUES.has(values[index]))
                index++;
        }
    }
    else if (values && typeof values === 'object') {
        const known = new Set(order.map((widget) => widget.name));
        for (const [name, value] of Object.entries(values))
            if (known.has(name))
                inputs[name] = value;
    }
    return inputs;
}
export function toApiPrompt(workflow, objectInfo) {
    if (isApiPrompt(workflow))
        return JSON.parse(JSON.stringify(workflow));
    const subgraphs = collectSubgraphs(workflow);
    const prompt = {};
    const scopeOf = (nodes, links, prefix, sub, parent) => ({
        prefix,
        nodes: new Map((nodes ?? []).map((node) => [Number(node.id), node])),
        links: linkTable(links),
        sub,
        parent
    });
    const childScope = (scope, instance) => {
        const sub = subgraphs.get(instance.type);
        return sub ? scopeOf(sub.nodes, sub.links, `${scope.prefix}${instance.id}:`, sub, { scope, instance }) : null;
    };
    const fromSubgraphInput = (scope, slot, depth) => {
        if (!scope.parent || !scope.sub)
            return null;
        const slotDef = scope.sub.inputs?.[slot];
        if (!slotDef)
            return null;
        const { instance } = scope.parent;
        const input = instance.inputs?.find((item) => item.name === slotDef.name);
        if (input?.link != null)
            return resolveLink(scope.parent.scope, input.link, depth + 1);
        const values = instance.widgets_values;
        if (Array.isArray(values) && values.length && !Array.isArray(instance.properties?.proxyWidgets)) {
            const widgetSlots = (scope.sub.inputs ?? []).filter((item) => typeof item.type === 'string' && WIDGET_TYPES.has(item.type));
            const index = widgetSlots.indexOf(slotDef);
            if (index >= 0 && index < values.length)
                return { value: values[index] };
        }
        return null;
    };
    const resolveOrigin = (scope, originId, slot, depth) => {
        if (depth > 64)
            return null;
        if (originId === -10)
            return fromSubgraphInput(scope, slot, depth);
        const source = scope.nodes.get(originId);
        if (!source || source.mode === 2)
            return null;
        if (source.type === 'Reroute') {
            const upstream = source.inputs?.[0]?.link;
            return upstream == null ? null : resolveLink(scope, upstream, depth + 1);
        }
        if (source.type === 'PrimitiveNode') {
            const values = source.widgets_values;
            return { value: Array.isArray(values) ? values[0] : undefined };
        }
        if (source.mode === 4) {
            const type = source.outputs?.[slot]?.type;
            const pass = source.inputs?.find((input) => input.link != null && (!type || input.type === type));
            return pass?.link == null ? null : resolveLink(scope, pass.link, depth + 1);
        }
        const child = childScope(scope, source);
        if (child) {
            const linkIds = child.sub?.outputs?.[slot]?.linkIds ?? [];
            const inner = linkIds.map((id) => child.links.get(id)).find(Boolean) ??
                [...child.links.values()].find((link) => link.to === -20 && link.toSlot === slot);
            return inner ? resolveOrigin(child, inner.from, inner.slot, depth + 1) : null;
        }
        return { ref: [`${scope.prefix}${source.id}`, slot] };
    };
    const resolveLink = (scope, linkId, depth = 0) => {
        const link = scope.links.get(linkId);
        return link ? resolveOrigin(scope, link.from, link.slot, depth) : null;
    };
    const emit = (scope, depth) => {
        for (const node of scope.nodes.values()) {
            if (node.mode === 2 || node.mode === 4 || FRONTEND_ONLY.has(node.type))
                continue;
            const child = childScope(scope, node);
            if (child) {
                if (depth >= 8)
                    throw new WorkflowError('local_workflow_unsupported', '子图嵌套过深');
                emit(child, depth + 1);
                continue;
            }
            if (node.type.startsWith('workflow>') || node.type.startsWith('workflow/')) {
                throw new WorkflowError('local_workflow_unsupported', `不支持组节点 ${node.type}`);
            }
            const info = objectInfo[node.type];
            if (!info)
                throw new WorkflowError('local_workflow_unsupported', `ComfyUI 没有节点 ${node.type}`);
            const inputs = widgetValues(node, info);
            for (const input of node.inputs ?? []) {
                if (input.link == null)
                    continue;
                const source = resolveLink(scope, input.link);
                if (!source)
                    continue;
                if ('value' in source && source.value === undefined)
                    continue;
                inputs[input.name] = 'ref' in source ? source.ref : source.value;
            }
            prompt[`${scope.prefix}${node.id}`] = { class_type: node.type, inputs };
        }
    };
    emit(scopeOf(workflow.nodes, workflow.links, ''), 0);
    return prompt;
}
export function usesApiNodes(prompt, objectInfo) {
    return Object.values(prompt).some((node) => objectInfo[node.class_type]?.api_node === true);
}
const PROMPT_KEYS = ['prompt', 'text', 'text_g', 'text_l', 'clip_l', 't5xxl', 'positive', 'positive_prompt', 'text_positive', 'global_prompt'];
const NEGATIVE_INPUT = /negative|^neg|uncond|cond2/i;
function isRef(value) {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number';
}
function promptKeys(node) {
    const keys = PROMPT_KEYS.filter((key) => typeof node.inputs[key] === 'string');
    if (!keys.length && /String|Text|Prompt/i.test(node.class_type) && typeof node.inputs.value === 'string')
        return ['value'];
    return keys;
}
function findPromptNodes(prompt) {
    const starts = [];
    for (const node of Object.values(prompt)) {
        if (!SAMPLES.test(node.class_type))
            continue;
        for (const [name, value] of Object.entries(node.inputs)) {
            if (isRef(value) && /^(positive|conditioning|cond1|positive_conditioning)$/i.test(name))
                starts.push(value[0]);
        }
    }
    const seen = new Set();
    let frontier = [...new Set(starts)];
    for (let depth = 0; depth < 10 && frontier.length; depth++) {
        const hits = [];
        const next = [];
        for (const id of frontier) {
            if (seen.has(id))
                continue;
            seen.add(id);
            const node = prompt[id];
            if (!node)
                continue;
            const keys = promptKeys(node);
            if (keys.length) {
                hits.push({ id, keys });
                continue;
            }
            for (const [name, value] of Object.entries(node.inputs)) {
                if (isRef(value) && !NEGATIVE_INPUT.test(name))
                    next.push(value[0]);
            }
        }
        if (hits.length)
            return hits;
        frontier = next;
    }
    return [];
}
export function applyRequest(prompt, request) {
    const next = JSON.parse(JSON.stringify(prompt));
    let targets = findPromptNodes(next);
    if (!targets.length) {
        const candidates = Object.entries(next).map(([id, node]) => ({ id, keys: promptKeys(node) })).filter((item) => item.keys.length);
        if (candidates.length === 1)
            targets = candidates;
    }
    if (!targets.length)
        throw new WorkflowError('local_workflow_unsupported', '工作流里找不到正向提示词输入');
    for (const target of targets)
        for (const key of target.keys)
            next[target.id].inputs[key] = request.prompt;
    for (const node of Object.values(next)) {
        for (const name of ['seed', 'noise_seed']) {
            if (typeof node.inputs[name] === 'number')
                node.inputs[name] = Math.floor(Math.random() * 2 ** 48);
        }
        if (request.width && request.height && /Latent/i.test(node.class_type) && 'width' in node.inputs && 'height' in node.inputs) {
            node.inputs.width = request.width;
            node.inputs.height = request.height;
        }
        if (request.filenamePrefix && (/^SaveImage/.test(node.class_type) || SAVES_VIDEO.test(node.class_type)) && 'filename_prefix' in node.inputs) {
            node.inputs.filename_prefix = request.filenamePrefix;
        }
        if (node.class_type === DIRECTOR)
            patchDirector(node, request);
    }
    if (request.video) {
        const loaders = Object.values(next).filter((node) => LOADS_VIDEO.test(node.class_type));
        const directed = Object.values(next).some((node) => node.class_type === DIRECTOR);
        if (!loaders.length && !directed)
            throw new WorkflowError('local_workflow_unsupported', '工作流里没有视频输入节点');
        for (const node of loaders)
            node.inputs[node.class_type === 'LoadVideo' ? 'file' : 'video'] = request.video.name;
    }
    if (request.images?.length) {
        const loaders = Object.values(next).filter((node) => LOADS_SINGLE_IMAGE.test(node.class_type) && 'image' in node.inputs);
        if (!loaders.length)
            throw new WorkflowError('local_workflow_unsupported', '工作流里没有 LoadImage 节点');
        loaders.forEach((node, index) => {
            node.inputs.image = request.images?.[Math.min(index, (request.images?.length ?? 1) - 1)];
        });
    }
    return next;
}
