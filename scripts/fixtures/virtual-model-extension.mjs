/**
 * Native virtual-model fixture for `scripts/test-virtual-model-native.mjs`.
 *
 * The test copies this file to `<PI_CODING_AGENT_DIR>/extensions/virtual-model-extension.js`
 * because bundled pi 1.2.0 native discovery only accepts `.ts` / `.js` (its
 * `isExtensionFile()`), while the source-of-truth fixture here is `.mjs`.
 *
 * It registers one virtual model under the loopback physical provider declared in the
 * isolated `models.json` written by the test. No network, credentials, or user data.
 */

export const VIRTUAL_PROVIDER = 'vmfix'
export const VIRTUAL_ID = 'vmfix-router'
export const PHYSICAL_ID = 'vmfix-physical'
export const VIRTUAL_CONTEXT_WINDOW = 111111
export const VIRTUAL_MAX_TOKENS = 4096

export default function (pi) {
  pi.registerVirtualModel({
    provider: VIRTUAL_PROVIDER,
    id: VIRTUAL_ID,
    name: 'VM fixture router',
    thinkingLevels: ['off', 'high'],
    contextWindow: VIRTUAL_CONTEXT_WINDOW,
    maxTokens: VIRTUAL_MAX_TOKENS,
    route(_request, ctx) {
      const model = ctx.modelRegistry.find(VIRTUAL_PROVIDER, PHYSICAL_ID)
      if (!model) throw new Error(`fixture physical model ${VIRTUAL_PROVIDER}/${PHYSICAL_ID} is not configured`)
      return { model, thinkingLevel: 'off' }
    }
  })
}
