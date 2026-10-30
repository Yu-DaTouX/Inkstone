import type { AuthProviderInfo, ModelInfo } from "../../../../shared/ipc";
import type { ProviderInstanceEntry, ProviderInstanceId } from "./contracts";

const EMPTY_ENTRIES: ReadonlyArray<ProviderInstanceEntry> = [];

function entryFrom(
  provider: string,
  info: AuthProviderInfo | undefined,
  setupMessage: (kind: "signIn" | "apiKey") => string,
): ProviderInstanceEntry {
  const ready = info?.status === "ready";
  const unknown = info?.status === "unknown" || info === undefined;
  return {
    instanceId: provider,
    driverKind: provider,
    displayName: info?.name?.trim() || provider,
    enabled: ready || unknown,
    installed: ready,
    isAvailable: ready,
    status: ready ? "ready" : unknown ? "warning" : "disabled",
    needsSetup: !ready,
    snapshot: {
      message: ready ? undefined : setupMessage(info?.inAppLogin ? "signIn" : "apiKey"),
    },
  };
}

export function providerInstanceEntries(input: {
  models: ReadonlyArray<ModelInfo>;
  providers: ReadonlyArray<AuthProviderInfo>;
  order: ReadonlyArray<string>;
  setupMessage: (kind: "signIn" | "apiKey") => string;
}): ReadonlyArray<ProviderInstanceEntry> {
  const byId = new Map(input.providers.map((info) => [info.id, info]));
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const provider of input.order) {
    if (byId.has(provider) || input.models.some((m) => m.provider === provider)) {
      if (!seen.has(provider)) {
        seen.add(provider);
        ids.push(provider);
      }
    }
  }
  for (const model of input.models) {
    if (!seen.has(model.provider)) {
      seen.add(model.provider);
      ids.push(model.provider);
    }
  }
  for (const info of input.providers) {
    if (!seen.has(info.id)) {
      seen.add(info.id);
      ids.push(info.id);
    }
  }
  if (ids.length === 0) return EMPTY_ENTRIES;
  return ids.map((provider) => entryFrom(provider, byId.get(provider), input.setupMessage));
}

export function isProviderInstancePickerReady(entry: ProviderInstanceEntry): boolean {
  return entry.installed && entry.isAvailable;
}

export function isProviderInstancePickerVisible(entry: ProviderInstanceEntry): boolean {
  return entry.enabled;
}

export function shouldShowInstanceBadge(): boolean {
  return false;
}

export function isProviderInstancePickerDisabled(
  _entry: ProviderInstanceEntry,
  _instanceId: ProviderInstanceId,
): boolean {
  return false;
}
