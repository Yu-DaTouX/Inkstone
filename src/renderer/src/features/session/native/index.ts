/**
 * 原生会话面板（v3）出口。
 *
 * Shell 唯一挂载 `NativeSessionSurfaces`；其余导出供工作区页签与测试复用，
 * 不新增第二套请求 / 归属口径。
 */
export {
  NativeSessionSurfaces,
  NativeSessionEntriesPanel,
  ScopeModelsSurface,
  ScopeModelsView,
  TrustSurface,
  TrustPanel,
  EntriesSurface,
  EntriesPanel,
  type NativeSessionSurfacesProps,
  type ScopeModelsSurfaceProps,
  type ScopeModelsViewProps,
  type TrustSurfaceProps,
  type TrustPanelProps,
  type EntriesSurfaceProps,
  type EntriesPanelProps
} from './NativeSessionSurfaces'

export {
  NATIVE_SURFACE_MODES,
  NATIVE_ENTRIES_MAX_ROWS,
  NATIVE_ENTRY_PREVIEW_MAX,
  NATIVE_ENTRIES_SCAN_MAX,
  isNativeSurfaceMode,
  nativeSurfaceText,
  buildScopedModelsView,
  buildTrustView,
  buildEntriesView,
  isScopeDirty,
  sameKeySet,
  scopeSaveIds,
  loadScopedModels,
  saveScopedModels,
  loadTrust,
  saveTrust,
  loadEntries,
  type NativeSurfaceMode,
  type NativeSurfaceTransport,
  type NativeSurfaceText,
  type NativeSurfaceLoad,
  type NativeSurfaceActionResult,
  type RawScopedModel,
  type ScopedModelOption,
  type ScopedModelsView,
  type TrustView,
  type EntriesView,
  type NativeEntryRow
} from './native-surfaces-model'
