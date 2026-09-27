/* Generated from src/shared/context-budget-v1.ts. Do not edit.
 * source-sha256: efb1684c24a7ded2081b13116e169448abd28597c247dae0ba88db64bf7b00de
 */
/**
 * Context budget V1. This module is deliberately pure so the host, UI and the
 * thin pi boundary can share one definition without importing runtime state.
 */
export const CONTEXT_BUDGET_V1_TIERS = [200_000, 300_000, 500_000, 700_000];
const MIN_ERROR_MARGIN = 2_048;
const ERROR_MARGIN_RATIO = 0.02;
const MIN_GROWTH = 16_000;
/**
 * API-specific output fields observed in the bundled pi 0.87.1 provider
 * builders. Unknown APIs intentionally have no adapter: a similarly named
 * field in an unrelated payload is not evidence of the request's real R.
 */
export const CONTEXT_BUDGET_OUTPUT_ADAPTERS_V1 = {
    'anthropic-messages': {
        api: 'anthropic-messages', adapterId: 'anthropic-max-tokens-v1',
        fieldPath: ['max_tokens'], accounting: 'provider-max-tokens-includes-thinking-when-configured'
    },
    'openai-completions': {
        api: 'openai-completions', adapterId: 'openai-completions-compat-v1',
        fieldPath: 'openai-completions-compat', accounting: 'provider-max-tokens-field-from-model-compat'
    },
    'openai-responses': {
        api: 'openai-responses', adapterId: 'openai-responses-max-output-tokens-v1',
        fieldPath: ['max_output_tokens'], accounting: 'responses-max-output-tokens-includes-reasoning'
    },
    'azure-openai-responses': {
        api: 'azure-openai-responses', adapterId: 'azure-openai-responses-max-output-tokens-v1',
        fieldPath: ['max_output_tokens'], accounting: 'responses-max-output-tokens-includes-reasoning'
    },
    'openai-codex-responses': {
        api: 'openai-codex-responses', adapterId: 'openai-codex-responses-max-output-tokens-v1',
        fieldPath: ['max_output_tokens'], accounting: 'responses-max-output-tokens-includes-reasoning'
    },
    'google-generative-ai': {
        api: 'google-generative-ai', adapterId: 'google-generation-config-v1',
        fieldPath: ['generationConfig', 'maxOutputTokens'], accounting: 'google-max-output-tokens-includes-thoughts-when-enabled'
    },
    'google-vertex': {
        api: 'google-vertex', adapterId: 'vertex-generation-config-v1',
        fieldPath: ['generationConfig', 'maxOutputTokens'], accounting: 'google-max-output-tokens-includes-thoughts-when-enabled'
    },
    'bedrock-converse-stream': {
        api: 'bedrock-converse-stream', adapterId: 'bedrock-inference-config-v1',
        fieldPath: ['inferenceConfig', 'maxTokens'], accounting: 'bedrock-inference-max-tokens'
    },
    'mistral-conversations': {
        api: 'mistral-conversations', adapterId: 'mistral-max-tokens-v1',
        fieldPath: ['maxTokens'], accounting: 'mistral-max-tokens-after-payload-normalization'
    }
};
function valueAtPath(value, path) {
    let current = value;
    for (const key of path) {
        if (!current || typeof current !== 'object' || Array.isArray(current))
            return undefined;
        current = current[key];
    }
    return current;
}
/** Resolve only the final output limit field defined by the selected provider API. */
export function resolveContextBudgetOutputReserveV1(input) {
    if (typeof input.api !== 'string')
        return { adapterId: 'unknown', outputReserve: null, reason: 'provider_api_unknown' };
    const adapter = CONTEXT_BUDGET_OUTPUT_ADAPTERS_V1[input.api];
    if (!adapter)
        return { adapterId: 'unsupported', outputReserve: null, reason: 'provider_api_unsupported' };
    let raw;
    if (adapter.fieldPath === 'openai-completions-compat') {
        const compat = input.compat && typeof input.compat === 'object' && !Array.isArray(input.compat)
            ? input.compat
            : {};
        // Pi's bundled OpenAI Completions adapter defaults to max_completion_tokens
        // when a model compatibility record does not name a field explicitly.
        const field = compat.maxTokensField === undefined ? 'max_completion_tokens' : compat.maxTokensField;
        if (field !== 'max_tokens' && field !== 'max_completion_tokens') {
            return { adapterId: adapter.adapterId, outputReserve: null, reason: 'provider_output_field_unknown' };
        }
        raw = valueAtPath(input.payload, [field]);
    }
    else {
        raw = valueAtPath(input.payload, adapter.fieldPath);
    }
    if (!validTokenCount(raw) || raw === 0) {
        return { adapterId: adapter.adapterId, outputReserve: null, reason: 'request_output_limit_unknown' };
    }
    return { adapterId: adapter.adapterId, outputReserve: raw, reason: 'request_output_limit_resolved' };
}
function validTokenCount(value) {
    return (typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0);
}
export function isContextBudgetTierV1(value) {
    return typeof value === 'number' && CONTEXT_BUDGET_V1_TIERS.includes(value);
}
export function normalizeContextBudgetTierV1(value) {
    return isContextBudgetTierV1(value) ? value : null;
}
/**
 * Stable, non-secret endpoint identity for one runtime model configuration.
 * Custom endpoint query strings and credentials are intentionally excluded.
 */
export function contextEndpointKeyV1(input) {
    if (typeof input.provider !== 'string' || !input.provider ||
        typeof input.api !== 'string' || !input.api ||
        typeof input.modelId !== 'string' || !input.modelId)
        return null;
    let endpointFingerprint = 'default';
    if (input.baseUrl !== undefined && input.baseUrl !== null && input.baseUrl !== '') {
        if (typeof input.baseUrl !== 'string')
            return null;
        try {
            const url = new URL(input.baseUrl);
            if (url.protocol !== 'http:' && url.protocol !== 'https:')
                return null;
            url.username = '';
            url.password = '';
            url.search = '';
            url.hash = '';
            const publicEndpoint = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
            let first = 0x811c9dc5;
            let second = 0x9e3779b9;
            for (let index = 0; index < publicEndpoint.length; index++) {
                const code = publicEndpoint.charCodeAt(index);
                first = Math.imul(first ^ code, 0x01000193);
                second = Math.imul(second ^ code, 0x85ebca6b);
            }
            endpointFingerprint = `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
        }
        catch {
            return null;
        }
    }
    return `${input.provider}/${input.api}/${input.modelId}/${endpointFingerprint}`;
}
/** Read only the bounded, body-free request snapshot written by the final pi hook. */
export function sanitizeContextBudgetRuntimeSnapshotV1(raw, sessionId, now = Date.now()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const value = raw;
    const endpoint = value.endpoint;
    const check = value.check;
    const calculation = check?.calculation;
    const numeric = (item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? item : null;
    const decision = check?.decision;
    const mode = check?.selectionMode;
    if (value.version !== 1 || value.stage !== 'final' || value.sessionId !== sessionId ||
        typeof value.requestRevision !== 'string' || !value.requestRevision || value.requestRevision.length > 200 ||
        typeof value.observedAt !== 'number' || !Number.isSafeInteger(value.observedAt) ||
        value.observedAt < 0 || value.observedAt > now + 60_000 || now - value.observedAt > 10 * 60_000 ||
        (value.countMode !== 'exact' && value.countMode !== 'estimated' && value.countMode !== 'unavailable') ||
        !endpoint || typeof endpoint.provider !== 'string' || typeof endpoint.modelId !== 'string' ||
        (endpoint.endpointKey !== null && typeof endpoint.endpointKey !== 'string') ||
        !check || (decision !== 'send' && decision !== 'review' && decision !== 'blocked' && decision !== 'unavailable') ||
        typeof check.reason !== 'string' || check.reason.length > 2000 ||
        typeof check.phaseId !== 'string' || check.phaseId.length > 120 ||
        (mode !== 'auto' && mode !== 'fixed') || typeof check.selectionReason !== 'string' ||
        !isContextBudgetTierV1(check.selectedBudget) || !isContextBudgetTierV1(check.autoMaxBudget) ||
        !calculation || typeof calculation.ok !== 'boolean' || typeof calculation.reason !== 'string' ||
        !Number.isSafeInteger(calculation.growth) || !isContextBudgetTierV1(calculation.selectedBudget))
        return null;
    const optionalLimit = (item) => item === null ? null : numeric(item);
    const calc = {
        ok: calculation.ok,
        reason: calculation.reason,
        capacityBasis: optionalLimit(calculation.capacityBasis),
        hardInputLimit: optionalLimit(calculation.hardInputLimit),
        errorMargin: optionalLimit(calculation.errorMargin),
        growth: calculation.growth,
        selectedBudget: calculation.selectedBudget,
        reviewLine: optionalLimit(calculation.reviewLine),
        targetAfterReview: optionalLimit(calculation.targetAfterReview)
    };
    return {
        version: 1,
        stage: 'final',
        sessionId,
        requestRevision: value.requestRevision,
        observedAt: value.observedAt,
        countMode: value.countMode,
        inputTokens: optionalLimit(value.inputTokens),
        messagesTokens: optionalLimit(value.messagesTokens),
        toolsTokens: optionalLimit(value.toolsTokens),
        systemTokens: optionalLimit(value.systemTokens),
        outputReserve: optionalLimit(value.outputReserve),
        endpoint: {
            provider: endpoint.provider,
            modelId: endpoint.modelId,
            endpointKey: typeof endpoint.endpointKey === 'string' ? endpoint.endpointKey : null
        },
        check: {
            decision,
            reason: check.reason,
            phaseId: check.phaseId,
            selectionMode: mode,
            selectionReason: check.selectionReason,
            selectedBudget: check.selectedBudget,
            autoMaxBudget: check.autoMaxBudget,
            calculation: calc
        }
    };
}
/** Conservative text estimate shared by host-side material planning and extension payload counts. */
export function estimateTextTokensV1(text) {
    if (typeof text !== 'string' || text.length === 0)
        return 0;
    let wide = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        const isWide = (cp >= 0x1100 && cp <= 0x11ff) ||
            (cp >= 0x2e80 && cp <= 0x2fff) ||
            (cp >= 0x3000 && cp <= 0x30ff) ||
            (cp >= 0x3100 && cp <= 0x31bf) ||
            (cp >= 0x3200 && cp <= 0x4dbf) ||
            (cp >= 0x4e00 && cp <= 0xa4cf) ||
            (cp >= 0xac00 && cp <= 0xd7af) ||
            (cp >= 0xf900 && cp <= 0xfaff) ||
            (cp >= 0xfe30 && cp <= 0xfe6f) ||
            (cp >= 0xff00 && cp <= 0xffef) ||
            (cp >= 0x20000 && cp <= 0x3ffff);
        if (isWide)
            wide += ch.length;
    }
    return Math.ceil(wide + (text.length - wide) / 4);
}
export function contextBudgetErrorMarginV1(capacityBasis) {
    if (!validTokenCount(capacityBasis) || capacityBasis === 0)
        return MIN_ERROR_MARGIN;
    return Math.max(MIN_ERROR_MARGIN, Math.ceil(capacityBasis * ERROR_MARGIN_RATIO));
}
/** Compute hard and soft limits from the actual endpoint shape and this request's R. */
export function calculateContextBudgetV1(input) {
    const selectedBudget = isContextBudgetTierV1(input.selectedBudget) ? input.selectedBudget : 200_000;
    const rawGrowth = input.registeredNextGrowth ?? 0;
    const growth = validTokenCount(rawGrowth) ? Math.max(MIN_GROWTH, rawGrowth) : MIN_GROWTH;
    const unavailable = (reason, capacityBasis = null) => ({
        ok: false,
        reason,
        capacityBasis,
        hardInputLimit: null,
        errorMargin: null,
        growth,
        selectedBudget,
        reviewLine: null,
        targetAfterReview: null
    });
    const capability = input.capability;
    if (!capability)
        return unavailable('endpoint_capability_unavailable');
    if (!capability.endpointKey || !capability.modelId || !capability.countingAdapter || !capability.revision) {
        return unavailable('endpoint_capability_incomplete');
    }
    if (!validTokenCount(capability.maxOutputTokens) || capability.maxOutputTokens === 0) {
        return unavailable('output_capacity_unknown');
    }
    if (!validTokenCount(input.outputReserve) || input.outputReserve === 0) {
        return unavailable('request_output_limit_unknown');
    }
    if (input.outputReserve > capability.maxOutputTokens)
        return unavailable('output_limit_invalid');
    let capacityBasis;
    let hardInputLimit;
    if (capability.mode === 'shared') {
        if (!validTokenCount(capability.contextWindow) || capability.contextWindow === 0) {
            return unavailable('context_window_unknown');
        }
        const limits = [capability.contextWindow];
        if (capability.maxInputTokens !== undefined) {
            if (!validTokenCount(capability.maxInputTokens) || capability.maxInputTokens === 0) {
                return unavailable('input_limit_invalid');
            }
            limits.push(capability.maxInputTokens);
        }
        capacityBasis = Math.min(...limits);
        hardInputLimit = Math.min(capability.contextWindow - input.outputReserve, ...limits);
    }
    else if (capability.mode === 'separate') {
        if (!validTokenCount(capability.maxInputTokens) || capability.maxInputTokens === 0) {
            return unavailable('input_limit_unknown');
        }
        capacityBasis = capability.maxInputTokens;
        hardInputLimit = capability.maxInputTokens;
    }
    else {
        return unavailable('capacity_mode_unknown');
    }
    const errorMargin = contextBudgetErrorMarginV1(capacityBasis);
    hardInputLimit -= errorMargin;
    const reviewLine = Math.min(selectedBudget, hardInputLimit - growth);
    if (hardInputLimit <= 0)
        return unavailable('hard_input_capacity_exhausted', capacityBasis);
    if (reviewLine <= 0) {
        return {
            ok: false,
            reason: 'review_capacity_exhausted',
            capacityBasis,
            hardInputLimit,
            errorMargin,
            growth,
            selectedBudget,
            reviewLine,
            targetAfterReview: Math.floor(reviewLine * 0.75)
        };
    }
    return {
        ok: true,
        reason: 'budget_available',
        capacityBasis,
        hardInputLimit,
        errorMargin,
        growth,
        selectedBudget,
        reviewLine,
        targetAfterReview: Math.floor(reviewLine * 0.75)
    };
}
/** Select the smallest legal tier from verified required material, never from stale history size. */
export function selectAutoContextBudgetV1(input) {
    const current = normalizeContextBudgetTierV1(input.currentBudget) ?? 200_000;
    const max = normalizeContextBudgetTierV1(input.autoMaxBudget) ?? 700_000;
    const calculation = calculateContextBudgetV1({
        capability: input.capability,
        outputReserve: input.outputReserve,
        selectedBudget: max,
        registeredNextGrowth: input.registeredNextGrowth
    });
    const noCandidate = (reason) => ({
        ok: false,
        selectedBudget: current,
        candidateBudget: null,
        reason,
        changed: false,
        deferredDownshift: false,
        calculation
    });
    if (!validTokenCount(input.requiredInputTokens))
        return noCandidate('required_input_count_unavailable');
    if (!calculation.hardInputLimit || calculation.hardInputLimit <= 0)
        return noCandidate(calculation.reason);
    const capacityAfterGrowth = calculation.hardInputLimit - calculation.growth;
    if (input.requiredInputTokens >= capacityAfterGrowth)
        return noCandidate('required_materials_exceed_endpoint_capacity');
    const legalTiers = CONTEXT_BUDGET_V1_TIERS.filter((tier) => tier <= max);
    const candidate = legalTiers.find((tier) => input.requiredInputTokens < Math.min(tier, capacityAfterGrowth));
    if (!candidate)
        return noCandidate('no_tier_fits_required_materials');
    if (candidate >= current) {
        return {
            ok: true,
            selectedBudget: candidate,
            candidateBudget: candidate,
            reason: candidate > current ? 'required_materials_need_larger_tier' : input.phaseChanged ? 'new_phase_minimum_tier' : 'current_tier_is_minimum_sufficient',
            changed: candidate !== current,
            deferredDownshift: false,
            calculation: calculateContextBudgetV1({
                capability: input.capability,
                outputReserve: input.outputReserve,
                selectedBudget: candidate,
                registeredNextGrowth: input.registeredNextGrowth
            })
        };
    }
    const candidateSoftLine = Math.min(candidate, capacityAfterGrowth);
    const lowEnough = input.requiredInputTokens <= Math.floor(candidateSoftLine * 0.8);
    const canProject = input.losslessProjectionFitsCandidate === true;
    const boundaries = Number.isSafeInteger(input.consecutiveLowBoundaries)
        ? Math.max(0, input.consecutiveLowBoundaries)
        : 0;
    if (input.phaseChanged) {
        if (!canProject) {
            return {
                ok: true,
                selectedBudget: current,
                candidateBudget: candidate,
                reason: 'phase_changed_waiting_for_lossless_projection',
                changed: false,
                deferredDownshift: true,
                calculation: calculateContextBudgetV1({
                    capability: input.capability,
                    outputReserve: input.outputReserve,
                    selectedBudget: current,
                    registeredNextGrowth: input.registeredNextGrowth
                })
            };
        }
        return {
            ok: true,
            selectedBudget: candidate,
            candidateBudget: candidate,
            reason: 'phase_changed_minimum_tier_after_lossless_projection',
            changed: candidate !== current,
            deferredDownshift: false,
            calculation: calculateContextBudgetV1({
                capability: input.capability,
                outputReserve: input.outputReserve,
                selectedBudget: candidate,
                registeredNextGrowth: input.registeredNextGrowth
            })
        };
    }
    if (!lowEnough || !canProject || boundaries < 2) {
        return {
            ok: true,
            selectedBudget: current,
            candidateBudget: candidate,
            reason: !lowEnough ? 'downshift_hysteresis_not_met' : !canProject ? 'lossless_projection_not_ready' : 'awaiting_second_low_boundary',
            changed: false,
            deferredDownshift: true,
            calculation: calculateContextBudgetV1({
                capability: input.capability,
                outputReserve: input.outputReserve,
                selectedBudget: current,
                registeredNextGrowth: input.registeredNextGrowth
            })
        };
    }
    return {
        ok: true,
        selectedBudget: candidate,
        candidateBudget: candidate,
        reason: 'downshift_after_two_low_boundaries',
        changed: candidate !== current,
        deferredDownshift: false,
        calculation: calculateContextBudgetV1({
            capability: input.capability,
            outputReserve: input.outputReserve,
            selectedBudget: candidate,
            registeredNextGrowth: input.registeredNextGrowth
        })
    };
}
/** Classify a prepared/final payload. Unknown counts or output settings fail closed. */
export function checkContextBudgetRequestV1(input) {
    const calculation = calculateContextBudgetV1({
        capability: input.capability,
        outputReserve: input.outputReserve,
        selectedBudget: input.selectedBudget,
        registeredNextGrowth: input.registeredNextGrowth
    });
    if (!calculation.ok)
        return { decision: 'unavailable', reason: calculation.reason, calculation };
    if (input.countMode === 'unavailable' || !validTokenCount(input.inputTokens)) {
        return { decision: 'unavailable', reason: 'request_input_count_unavailable', calculation };
    }
    if (input.inputTokens > calculation.hardInputLimit) {
        return { decision: 'blocked', reason: 'hard_input_limit_exceeded', calculation };
    }
    if (input.inputTokens >= calculation.reviewLine) {
        return { decision: input.countMode === 'exact' ? 'review' : 'review', reason: 'soft_review_line_reached', calculation };
    }
    return { decision: 'send', reason: 'within_review_line', calculation };
}
