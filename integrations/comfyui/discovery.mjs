import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { classifyWorkflow, isApiPrompt } from './workflow.mjs';
const PROBE_TIMEOUT_MS = 1500;
const IMAGE_CACHE_MS = 30000;
export function localServiceBase(raw, port) {
    const value = raw?.trim();
    if (!value)
        return `http://127.0.0.1:${port}`;
    try {
        const hasScheme = /^[a-z]+:\/\//i.test(value);
        const url = new URL(hasScheme ? value : `http://${value}`);
        if (url.hostname === '0.0.0.0' || url.hostname === '[::]')
            url.hostname = '127.0.0.1';
        if (!url.port && !hasScheme)
            url.port = String(port);
        return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    }
    catch {
        return `http://127.0.0.1:${port}`;
    }
}
async function getJson(url) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!response.ok)
            return undefined;
        return await response.json().catch(() => undefined);
    }
    catch {
        return undefined;
    }
}
export function sortWorkflows(entries) {
    return [...entries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'text-to-image' ? -1 : 1));
}
export async function fetchComfyWorkflow(baseUrl, name, signal) {
    const response = await fetch(`${baseUrl}/api/userdata/${encodeURIComponent(`workflows/${name}`)}`, { signal: signal ?? AbortSignal.timeout(10_000) });
    if (!response.ok)
        throw new Error(`comfy_workflow_http_${response.status}`);
    return await response.json();
}
function classify(json) {
    return json && typeof json === 'object' && (Array.isArray(json.nodes) || isApiPrompt(json)) ? classifyWorkflow(json) : null;
}
export async function listComfyWorkflows(baseUrl) {
    const response = await fetch(`${baseUrl}/api/userdata?dir=workflows&recurse=true`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok)
        return [];
    const names = (await response.json().catch(() => [])).filter((name) => typeof name === 'string' && name.endsWith('.json')).slice(0, 100);
    const deadline = AbortSignal.timeout(2_500);
    const out = await Promise.all(names.map(async (name) => {
        try {
            const kind = classify(await fetchComfyWorkflow(baseUrl, name, deadline));
            return kind ? { name, kind } : null;
        }
        catch {
            return null;
        }
    }));
    return sortWorkflows(out.filter((entry) => !!entry));
}
async function probeComfy(root) {
    const stats = (await getJson(`${root}/system_stats`));
    if (!stats?.system)
        return null;
    const workflows = await listComfyWorkflows(root).catch(() => []);
    return { kind: 'comfyui', purpose: 'image', name: 'ComfyUI', baseUrl: root, models: workflows.map((item) => item.name), running: true };
}
function windowsDrives() {
    return process.platform === 'win32' ? [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:\\`).filter((drive) => existsSync(drive)) : [];
}
function appDataDirs() {
    const home = homedir();
    if (process.platform === 'win32')
        return [process.env.APPDATA ?? join(home, 'AppData', 'Roaming')];
    if (process.platform === 'darwin')
        return [join(home, 'Library', 'Application Support')];
    return [process.env.XDG_CONFIG_HOME ?? join(home, '.config'), join(home, '.local', 'share')];
}
function installParents() {
    const home = homedir();
    const drives = windowsDrives();
    return [home, join(home, 'Documents'), join(home, 'Desktop'), join(home, 'AI'), ...drives, ...drives.map((drive) => join(drive, 'AI'))];
}
async function comfyDesktopBasePaths() {
    const out = [];
    for (const dir of appDataDirs()) {
        try {
            const config = JSON.parse(await readFile(join(dir, 'ComfyUI', 'config.json'), 'utf8'));
            if (typeof config.basePath === 'string' && config.basePath)
                out.push(config.basePath);
        }
        catch {
        }
    }
    return out;
}
function installScanOff() {
    return process.env.YAN_LOCAL_INSTALL_SCAN?.trim().toLowerCase() === 'off';
}
export async function comfyInstallCandidates() {
    const configured = process.env.YAN_COMFYUI_DIR?.trim();
    if (installScanOff())
        return configured ? [configured] : [];
    const fromParents = installParents().flatMap((parent) => [
        join(parent, 'ComfyUI'),
        join(parent, 'ComfyUI_windows_portable', 'ComfyUI'),
        join(parent, 'pinokio', 'api', 'comfy.git', 'app')
    ]);
    const stabilityMatrix = appDataDirs().map((dir) => join(dir, 'StabilityMatrix', 'Packages', 'ComfyUI'));
    return [...(configured ? [configured] : []), ...(await comfyDesktopBasePaths()), ...fromParents, ...stabilityMatrix];
}
export function isComfyInstall(dir) {
    try {
        return existsSync(join(dir, 'user')) && (existsSync(join(dir, 'main.py')) || existsSync(join(dir, 'models')));
    }
    catch {
        return false;
    }
}
async function walkJson(dir, root, depth = 0) {
    if (depth > 3)
        return [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory())
            out.push(...(await walkJson(path, root, depth + 1)));
        else if (entry.name.endsWith('.json'))
            out.push(relative(root, path).replace(/\\/g, '/'));
    }
    return out;
}
export async function readInstalledWorkflows(installDir) {
    const root = join(installDir, 'user', 'default', 'workflows');
    const out = [];
    for (const name of await walkJson(root, root)) {
        try {
            const kind = classify(JSON.parse(await readFile(join(root, name), 'utf8')));
            if (kind)
                out.push({ name, kind });
        }
        catch {
        }
    }
    return sortWorkflows(out);
}
export function resetLocalImageCache() { }
export async function detectLocalImageService() {
    const roots = [...new Set([process.env.YAN_COMFYUI_URL, ...[8188, 8000, 8189].map(p => 'http://127.0.0.1:' + p)].filter(Boolean))];
    const found = await Promise.all(roots.map(root => probeComfy(localServiceBase(root, 8188))));
    return found.find(Boolean) ?? null;
}
