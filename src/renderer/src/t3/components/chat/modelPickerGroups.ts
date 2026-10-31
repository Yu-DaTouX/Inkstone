import { modelBrand } from "../../../../../shared/model-brand";

export type ModelVendor = { key: string; label: string };

const VENDOR_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(anthropic|claude)$/, "anthropic"],
  [/^(openai|chatgpt|codex)$/, "openai"],
  [/^deepseek(-ai)?$/, "deepseek"],
  [/^(qwen|alibaba|alibaba-cloud|dashscope)$/, "qwen"],
  [/^(google|gemini)$/, "google"],
  [/^(moonshot|moonshotai|kimi)$/, "moonshotai"],
  [/^(z-ai|zai|zai-org|thudm|zhipu|zhipuai|glm)$/, "zai"],
  [/^(x-ai|xai|grok)$/, "xai"],
  [/^(minimax|minimaxai)$/, "minimax"],
  [/^(meta|meta-llama)$/, "meta"],
];

const BRAND_VENDORS: Readonly<Record<string, string>> = {
  claude: "anthropic",
  codex: "openai",
  deepseek: "deepseek",
  qwen: "qwen",
  gemini: "google",
  kimi: "moonshotai",
  glm: "zai",
  grok: "xai",
};

const VENDOR_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  google: "Google",
  moonshotai: "Moonshot AI",
  zai: "Z.ai",
  xai: "xAI",
  minimax: "MiniMax",
  meta: "Meta",
  nvidia: "NVIDIA",
  xiaomi: "Xiaomi",
  stepfun: "StepFun",
  tencent: "Tencent",
  meituan: "Meituan",
  inclusionai: "inclusionAI",
  thinkingmachines: "Thinking Machines",
};

function vendorLabel(key: string): string {
  return VENDOR_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

export function modelVendor(slug: string): ModelVendor | null {
  const segments = slug.toLowerCase().split("/").filter(Boolean);
  if (segments.length > 1) {
    const raw = segments[0]!;
    const key = VENDOR_ALIASES.find(([pattern]) => pattern.test(raw))?.[1] ?? raw;
    return { key, label: vendorLabel(key) };
  }
  const key = BRAND_VENDORS[modelBrand({ id: slug })];
  return key ? { key, label: vendorLabel(key) } : null;
}

const VERSION_PATTERN = /\d+(?:[.-]\d+)*/u;

function modelFamily(slug: string): { family: string; major: number } | null {
  const name = (slug.toLowerCase().split("/").pop() ?? "").replace(/:[a-z]+$/u, "");
  const version = name.match(VERSION_PATTERN)?.[0];
  if (!version) return null;
  const major = Number(version.split(/[.-]/u)[0]);
  if (!Number.isFinite(major)) return null;
  const family = name
    .replace(/\d+(?:[.-]\d+)*/gu, " ")
    .replace(/[^a-z]+/gu, " ")
    .trim();
  return family ? { family, major } : null;
}

export function legacyModelSlugs(
  slugs: ReadonlyArray<string>,
  keep: (slug: string) => boolean,
): ReadonlySet<string> {
  const newest = new Map<string, number>();
  const parsed = new Map<string, { family: string; major: number }>();
  for (const slug of slugs) {
    const info = modelFamily(slug);
    if (!info) continue;
    const family = `${modelVendor(slug)?.key ?? ""}:${info.family}`;
    parsed.set(slug, { family, major: info.major });
    newest.set(family, Math.max(newest.get(family) ?? -Infinity, info.major));
  }
  const legacy = new Set<string>();
  for (const [slug, info] of parsed) {
    if (keep(slug)) continue;
    if (info.major < (newest.get(info.family) ?? info.major)) legacy.add(slug);
  }
  return legacy;
}
