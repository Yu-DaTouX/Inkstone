/* 由 src/shared/custom-provider.ts 生成，勿手改；重新生成：node scripts/build-model-capabilities.mjs
 * source-sha256: 697cb1384b9cc6a7278be592590037a84e4b6bb072c9f8b4efed88eb44869dd4
 */
// src/shared/custom-provider.ts
var PI_API_IDS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "azure-openai-responses",
  "mistral-conversations",
  "bedrock-converse-stream",
  "openai-codex-responses",
  "openrouter-images",
  "pi-messages"
];
var CUSTOM_API_CHOICES = [
  { id: "openai-completions", label: "OpenAI Chat Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "google-generative-ai", label: "Google Generative AI" },
  { id: "mistral-conversations", label: "Mistral Conversations" }
];
var THINKING_LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function cleanThinkingLevelMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const out = {};
  for (const key of THINKING_LEVEL_KEYS) {
    const v = value[key];
    if (v === null || typeof v === "string" && v.trim() && !hasExecutablePrefix(v)) out[key] = v;
  }
  return Object.keys(out).length ? out : void 0;
}
function isCustomApiId(value) {
  return CUSTOM_API_CHOICES.some((choice) => choice.id === value);
}
var CUSTOM_PROVIDER_PREFIX = "yan-";
function isYanProviderId(value) {
  return typeof value === "string" && /^yan-[a-z0-9][a-z0-9-]*$/.test(value);
}
function hasExecutablePrefix(value) {
  return value.trimStart().startsWith("!");
}
function validateBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "Base URL \u4E0D\u80FD\u4E3A\u7A7A";
  const raw = value.trim();
  if (hasExecutablePrefix(raw)) return "Base URL \u4E0D\u80FD\u4EE5 ! \u5F00\u5934\uFF08\u53EF\u6267\u884C\u5B57\u7B26\u4E32\u4E0D\u5141\u8BB8\u5199\u76D8\uFF09";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "Base URL \u4E0D\u662F\u5408\u6CD5\u5730\u5740";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Base URL \u53EA\u652F\u6301 http / https";
  return null;
}
function validateCustomProvider(input) {
  const errors = [];
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!isYanProviderId(id)) {
    errors.push(`Provider ID \u5FC5\u987B\u5F62\u5982 ${CUSTOM_PROVIDER_PREFIX}xxx\uFF08\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u8FDE\u5B57\u7B26\uFF09`);
  }
  const api = typeof input.api === "string" ? input.api : "";
  if (!CUSTOM_API_CHOICES.some((choice) => choice.id === api)) {
    errors.push("\u8BF7\u9009\u62E9\u4E00\u4E2A\u53D7\u652F\u6301\u7684\u534F\u8BAE");
  }
  const urlError = validateBaseUrl(input.baseUrl);
  if (urlError) errors.push(urlError);
  const models = Array.isArray(input.models) ? input.models : [];
  const cleaned = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of models) {
    const modelId = typeof raw?.id === "string" ? raw.id.trim() : "";
    if (!modelId) {
      errors.push("\u6A21\u578B ID \u4E0D\u80FD\u4E3A\u7A7A");
      continue;
    }
    if (hasExecutablePrefix(modelId)) {
      errors.push(`\u6A21\u578B ID\u300C${modelId}\u300D\u4E0D\u80FD\u4EE5 ! \u5F00\u5934`);
      continue;
    }
    if (seen.has(modelId)) {
      errors.push(`\u6A21\u578B ID \u91CD\u590D\uFF1A${modelId}`);
      continue;
    }
    seen.add(modelId);
    const next = { id: modelId };
    if (typeof raw.name === "string" && raw.name.trim()) next.name = raw.name.trim();
    for (const key of ["contextWindow", "maxTokens"]) {
      const value2 = raw[key];
      if (typeof value2 === "number" && Number.isFinite(value2) && value2 > 0) next[key] = Math.round(value2);
    }
    if (raw.reasoning === true) next.reasoning = true;
    if (Array.isArray(raw.input)) {
      const kinds = raw.input.filter((kind) => kind === "text" || kind === "image");
      if (kinds.length) next.input = [...new Set(kinds)];
    }
    if (raw.api !== void 0) {
      if (isCustomApiId(raw.api)) next.api = raw.api;
      else errors.push(`\u6A21\u578B\u300C${modelId}\u300D\u7684\u534F\u8BAE\u4E0D\u53D7\u652F\u6301`);
    }
    if (raw.baseUrl !== void 0) {
      const modelUrlError = validateBaseUrl(raw.baseUrl);
      if (modelUrlError) errors.push(`\u6A21\u578B\u300C${modelId}\u300D\uFF1A${modelUrlError}`);
      else next.baseUrl = String(raw.baseUrl).trim();
    }
    if (next.reasoning) {
      const map = cleanThinkingLevelMap(raw.thinkingLevelMap);
      if (map) next.thinkingLevelMap = map;
    }
    cleaned.push(next);
  }
  if (!cleaned.length) errors.push("\u81F3\u5C11\u8981\u6709\u4E00\u4E2A\u6A21\u578B");
  if (typeof input.apiKey === "string" && hasExecutablePrefix(input.apiKey)) {
    errors.push("API Key \u4E0D\u80FD\u662F ! \u5F00\u5934\u7684\u53EF\u6267\u884C\u5B57\u7B26\u4E32");
  }
  if (errors.length) return { ok: false, errors };
  const value = { id, api, baseUrl: String(input.baseUrl).trim(), models: cleaned };
  if (typeof input.apiKey === "string" && input.apiKey.trim()) value.apiKey = input.apiKey.trim();
  return { ok: true, errors: [], value };
}
function readCustomProviders(modelsJson) {
  const providers = modelsJson?.providers;
  if (!providers || typeof providers !== "object") return [];
  const out = [];
  for (const [id, raw] of Object.entries(providers)) {
    if (!isYanProviderId(id)) continue;
    const entry = raw ?? {};
    const models = Array.isArray(entry.models) ? entry.models : [];
    out.push({
      id,
      api: typeof entry.api === "string" ? entry.api : "",
      baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
      models: models.filter((m) => !!m && typeof m === "object").map((m) => {
        const model = { id: typeof m.id === "string" ? m.id : "" };
        if (typeof m.name === "string") model.name = m.name;
        if (typeof m.contextWindow === "number") model.contextWindow = m.contextWindow;
        if (typeof m.maxTokens === "number") model.maxTokens = m.maxTokens;
        if (m.reasoning === true) model.reasoning = true;
        if (Array.isArray(m.input)) {
          model.input = m.input.filter((k) => k === "text" || k === "image");
        }
        if (isCustomApiId(m.api)) model.api = m.api;
        if (typeof m.baseUrl === "string" && m.baseUrl) model.baseUrl = m.baseUrl;
        const map = m.reasoning === true ? cleanThinkingLevelMap(m.thinkingLevelMap) : void 0;
        if (map) model.thinkingLevelMap = map;
        return model;
      }).filter((m) => m.id),
      /* 只报告有没有，不回明文 */
      hasApiKey: typeof entry.apiKey === "string" && entry.apiKey.length > 0
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
function mergeCustomProviders(modelsJson, updates, removals = []) {
  const base = modelsJson && typeof modelsJson === "object" ? { ...modelsJson } : {};
  const providers = base.providers && typeof base.providers === "object" ? { ...base.providers } : {};
  let changed = false;
  for (const id of removals) {
    if (!isYanProviderId(id)) continue;
    if (id in providers) {
      delete providers[id];
      changed = true;
    }
  }
  for (const update of updates) {
    if (!isYanProviderId(update.id)) continue;
    const previous = providers[update.id] ?? {};
    const entry = { ...previous, api: update.api, baseUrl: update.baseUrl };
    entry.models = update.models;
    if (update.apiKey) entry.apiKey = update.apiKey;
    else if (typeof previous.apiKey === "string") entry.apiKey = previous.apiKey;
    providers[update.id] = entry;
    changed = true;
  }
  if (!changed) return { next: base, changed: false };
  base.providers = providers;
  return { next: base, changed: true };
}
function maskCustomProvider(view) {
  return { ...view, apiKeyLabel: view.hasApiKey ? "\u2022\u2022\u2022\u2022\u2022\u2022" : "" };
}
function parseModelList(json) {
  return parseModelEntries(json).map((model) => model.id);
}
function parseModelEntries(json) {
  const root = json;
  const list = Array.isArray(root) ? root : Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  const out = [];
  for (const item of list) {
    const entry = item;
    if (typeof entry === "object" && entry && Array.isArray(entry.supportedGenerationMethods) && !entry.supportedGenerationMethods.includes("generateContent")) continue;
    const raw = typeof entry === "string" ? entry : typeof entry?.id === "string" ? entry.id : typeof entry?.name === "string" ? entry.name : "";
    const id = raw.replace(/^models\//, "").trim();
    if (!id || hasExecutablePrefix(id) || out.some((m) => m.id === id)) continue;
    const model = { id };
    if (typeof entry === "object" && entry) {
      if (typeof entry.name === "string" && entry.name.trim() && entry.name !== raw) model.name = entry.name.trim();
      if (typeof entry.display_name === "string" && entry.display_name.trim()) model.name = entry.display_name.trim();
      const context = [entry.context_length, entry.context_window, entry.inputTokenLimit].find((v) => typeof v === "number" && v > 0);
      if (typeof context === "number") model.contextWindow = Math.round(context);
      if (Array.isArray(entry.supported_endpoints)) model.endpoints = entry.supported_endpoints.filter((p) => typeof p === "string");
      if (Array.isArray(entry.supported_parameters)) {
        const params = entry.supported_parameters.filter((p) => typeof p === "string");
        if (params.includes("reasoning") || params.includes("include_reasoning") || params.includes("reasoning_effort")) model.reasoning = true;
      }
      if (entry.thinking === true) model.reasoning = true;
      const modalities = entry.architecture?.input_modalities;
      if (Array.isArray(modalities) && modalities.includes("image")) model.image = true;
    }
    out.push(model);
  }
  return out;
}
function catalogKey(id) {
  return id.trim().toLowerCase().replace(/:free$/, "").replace(/^.*\//, "").replace(/\./g, "-");
}
var ENDPOINT_APIS = [
  ["/chat/completions", "openai-completions"],
  ["/responses", "openai-responses"],
  ["/messages", "anthropic-messages"]
];
function baseUrlForApi(baseUrl, from, to) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const anthropic = (api) => api === "anthropic-messages";
  if (anthropic(to) && !anthropic(from)) return trimmed.replace(/\/v\d+$/, "");
  if (!anthropic(to) && anthropic(from) && !/\/v\d+$/.test(trimmed)) return `${trimmed}/v1`;
  return trimmed;
}
function describeDiscoveredModels(found, provider, catalog) {
  return found.map((item) => {
    const model = { id: item.id };
    if (item.name) model.name = item.name;
    let api = provider.api;
    const endpoints = item.endpoints ?? [];
    const native = ENDPOINT_APIS.find(([, id]) => id === provider.api)?.[0];
    if (endpoints.length && native && !endpoints.includes(native)) {
      const alternative = ENDPOINT_APIS.find(([path]) => endpoints.includes(path));
      if (alternative) {
        api = alternative[1];
        model.api = alternative[1];
        model.baseUrl = baseUrlForApi(provider.baseUrl, provider.api, alternative[1]);
      }
    }
    const known = catalog[catalogKey(item.id)];
    const reasoning = item.reasoning ?? known?.reasoning;
    if (reasoning) model.reasoning = true;
    if (item.image || known?.input?.includes("image")) model.input = ["text", "image"];
    const contextWindow = item.contextWindow ?? known?.contextWindow;
    if (contextWindow) model.contextWindow = contextWindow;
    if (known?.maxTokens) model.maxTokens = contextWindow ? Math.min(known.maxTokens, contextWindow) : known.maxTokens;
    if (reasoning && known?.thinkingLevelMap && known.api === api && api !== "openai-completions") {
      model.thinkingLevelMap = { ...known.thinkingLevelMap };
    }
    return model;
  });
}
export {
  CUSTOM_API_CHOICES,
  CUSTOM_PROVIDER_PREFIX,
  PI_API_IDS,
  catalogKey,
  describeDiscoveredModels,
  hasExecutablePrefix,
  isYanProviderId,
  maskCustomProvider,
  mergeCustomProviders,
  parseModelEntries,
  parseModelList,
  readCustomProviders,
  validateBaseUrl,
  validateCustomProvider
};
