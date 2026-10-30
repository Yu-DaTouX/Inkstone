export type ProviderInstanceId = string;

export type ProviderDriverKind = string;

export interface ModelSelection {
  instanceId: ProviderInstanceId;
  model: string;
}

export interface ProviderInstanceSnapshot {
  message?: string | undefined;
}

export interface ProviderInstanceEntry {
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  isAvailable: boolean;
  status: "ready" | "warning" | "error" | "disabled";
  needsSetup: boolean;
  snapshot: ProviderInstanceSnapshot;
}
