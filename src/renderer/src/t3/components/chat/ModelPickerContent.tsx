import { memo, useState, useEffect, useEffectEvent, useRef, type RefObject } from "react";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { modelPickerModelKey, parseModelPickerModelKey } from "./modelPickerKeys";
import { rankModelPickerSearch } from "./modelPickerSearch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxList,
} from "../ui/combobox";
import type { ModelEsque } from "./providerIconUtils";
import { cn } from "../../lib/utils";
import { TooltipProvider } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
} from "../../adapters/providers";
import { providerModelKey, sortProviderModelItems } from "../../adapters/composer-model";
import { MODEL_JUMP_LIMIT, modelJumpLabel } from "../../adapters/shortcuts";
import type { ProviderInstanceEntry, ProviderInstanceId } from "../../adapters/contracts";
import { useT } from "../../../i18n";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  instanceId: ProviderInstanceId;
  driverKind: string;
  instanceDisplayName: string;
  isUnavailable?: boolean | undefined;
};

const ONE_LINE_ROW_UNITS = 8;
const TWO_LINE_ROW_UNITS = 12;
const ROW_SEPARATOR_UNITS = 0.5;
const LIST_CHROME_UNITS = 15.5;

function WindowKeyDownListener({ onKeyDown }: { onKeyDown: (event: KeyboardEvent) => void }) {
  const handleKeyDown = useEffectEvent(onKeyDown);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
    };
  }, []);
  return null;
}

export function resolveModelPickerSelectedModel(input: {
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  return input.options.find((option) => option.slug === input.model);
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  activeInstanceId: ProviderInstanceId;
  model: string;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  favoriteKeys: ReadonlySet<string>;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  onToggleFavorite: (instanceId: ProviderInstanceId, model: string) => void;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  searchInputRef: RefObject<HTMLInputElement | null>;
}) {
  const t = useT();
  const {
    searchInputRef,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
    onToggleFavorite,
    onRequestClose,
    onOpenProviderSetup,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const pickerContentRef = useRef<HTMLDivElement>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const favoritesSet = props.favoriteKeys;
  const activeModel = resolveModelPickerSelectedModel({
    model: props.model,
    options: modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const activeModelSlug = activeModel?.slug ?? props.model;
  const activeModelKey = activeModelSlug
    ? modelPickerModelKey(props.activeInstanceId, activeModelSlug)
    : null;
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | "favorites">(
    () => (favoritesSet.size > 0 ? "favorites" : props.activeInstanceId),
  );
  const [searchHeight, setSearchHeight] = useState(0);

  const focusSearchInput = () => {
    searchInputRef.current?.focus({ preventScroll: true });
  };

  const handleSelectInstance = (instanceId: ProviderInstanceId | "favorites") => {
    setSelectedInstanceId(instanceId);
    window.requestAnimationFrame(() => {
      focusSearchInput();
    });
  };

  const handleModelSelect = (modelSlug: string, instanceId: ProviderInstanceId): void => {
    if (getModelDisabledReason?.(instanceId, modelSlug)) {
      return;
    }
    const options = modelOptionsByInstance.get(instanceId);
    if (!options) {
      return;
    }
    const resolved = options.find((option) => option.slug === modelSlug);
    if (!resolved) return;
    onInstanceModelChange(instanceId, resolved.slug);
  };

  const entryByInstanceId = new Map(instanceEntries.map((entry) => [entry.instanceId, entry]));
  const canOpenProviderSetup = onOpenProviderSetup !== undefined;

  const selectableUnavailableInstanceIds = (() => {
    if (!canOpenProviderSetup) return undefined;
    const instanceIds = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (!isProviderInstancePickerReady(entry) && entry.enabled) {
        instanceIds.add(entry.instanceId);
      }
    }
    return instanceIds.size > 0 ? instanceIds : undefined;
  })();

  const flatModels = (() => {
    const out: ModelPickerItem[] = [];
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) continue;
      for (const model of models) {
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.badge ? { badge: model.badge } : {}),
          ...(model.isUnavailable ? { isUnavailable: true } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
        });
      }
    }
    return out;
  })();

  const isSearching = searchQuery.trim().length > 0;
  const rowsMixProviders = isSearching || selectedInstanceId === "favorites";
  const tallestTabUnits = (() => {
    const unitsByTab = new Map<ProviderInstanceId | "favorites", number>();
    for (const model of flatModels) {
      const isFavorite = favoritesSet.has(providerModelKey(model.instanceId, model.slug));
      const rowUnits = isFavorite || model.subProvider ? TWO_LINE_ROW_UNITS : ONE_LINE_ROW_UNITS;
      const addRow = (tab: ProviderInstanceId | "favorites") => {
        const previous = unitsByTab.get(tab);
        unitsByTab.set(
          tab,
          previous === undefined ? rowUnits : previous + ROW_SEPARATOR_UNITS + rowUnits,
        );
      };
      if (isFavorite) addRow("favorites");
      addRow(model.instanceId);
    }
    return Math.max(0, ...unitsByTab.values());
  })();
  const sidebarInstanceEntries = instanceEntries.filter(isProviderInstancePickerVisible);
  const showSidebar = !isSearching && sidebarInstanceEntries.length > 0;

  const filteredModels = (() => {
    if (isSearching) {
      return rankModelPickerSearch(flatModels, searchQuery, (model) => ({
        name: model.name,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        driverKind: model.driverKind,
        providerDisplayName: model.instanceDisplayName,
        isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
      }));
    }
    const result =
      selectedInstanceId === "favorites"
        ? flatModels.filter((model) =>
            favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
          )
        : flatModels.filter((model) => model.instanceId === selectedInstanceId);
    return sortProviderModelItems(result, {
      favoriteModelKeys: favoritesSet,
      groupFavorites: selectedInstanceId !== "favorites",
      instanceOrder: selectedInstanceId === "favorites" ? instanceEntries.map((e) => e.instanceId) : [],
    });
  })();

  const selectedEntry =
    selectedInstanceId === "favorites" ? undefined : entryByInstanceId.get(selectedInstanceId);
  const providerSetupEntries =
    !isSearching && canOpenProviderSetup
      ? instanceEntries.filter(
          (entry) =>
            !isProviderInstancePickerReady(entry) &&
            (selectedEntry
              ? entry.instanceId === selectedEntry.instanceId
              : filteredModels.length === 0),
        )
      : [];

  const jumpModelKeys = filteredModels
    .filter((model) => !getModelDisabledReason?.(model.instanceId, model.slug))
    .slice(0, MODEL_JUMP_LIMIT)
    .map((model) => modelPickerModelKey(model.instanceId, model.slug));
  const jumpLabelByKey = new Map<string, string>();
  jumpModelKeys.forEach((key, index) => {
    const label = modelJumpLabel(index);
    if (label) jumpLabelByKey.set(key, label);
  });

  const allItemKeys = flatModels.map((model) => modelPickerModelKey(model.instanceId, model.slug));
  const filteredItemKeys = filteredModels.map((model) =>
    modelPickerModelKey(model.instanceId, model.slug),
  );
  const filteredModelByKey = new Map(
    filteredModels.map(
      (model) => [modelPickerModelKey(model.instanceId, model.slug), model] as const,
    ),
  );

  const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat) return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const digit = Number(event.key);
    if (!Number.isInteger(digit) || digit < 1 || digit > MODEL_JUMP_LIMIT) return;
    const targetModelKey = jumpModelKeys[digit - 1];
    if (!targetModelKey) return;
    event.preventDefault();
    event.stopPropagation();
    const model = parseModelPickerModelKey(targetModelKey);
    if (model) handleModelSelect(model.slug, model.instanceId);
  };

  return (
    <TooltipProvider delay={0}>
      <WindowKeyDownListener onKeyDown={onWindowKeyDown} />
      <div
        ref={pickerContentRef}
        className="relative flex max-h-86.5 w-screen max-w-90 flex-row overflow-hidden"
        style={
          isSearching
            ? { height: searchHeight }
            : {
                minHeight: `min(calc(var(--spacing) * ${tallestTabUnits + LIST_CHROME_UNITS} + 1px), calc(var(--spacing) * 86.5))`,
              }
        }
        data-model-picker-content="true"
      >
        {showSidebar && (
          <ModelPickerSidebar
            selectedInstanceId={selectedInstanceId}
            onSelectInstance={handleSelectInstance}
            onFocusSearch={focusSearchInput}
            instanceEntries={sidebarInstanceEntries}
            showFavorites
            {...(selectableUnavailableInstanceIds ? { selectableUnavailableInstanceIds } : {})}
          />
        )}

        <Combobox<string>
          inline
          items={allItemKeys}
          filteredItems={filteredItemKeys}
          filter={null}
          autoHighlight
          open
          value={activeModelKey}
          onItemHighlighted={(modelKey) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
          }}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            const model = parseModelPickerModelKey(value);
            if (model) handleModelSelect(model.slug, model.instanceId);
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
              showSidebar && "border-l border-border/70",
            )}
          >
            <ComboboxSearchInput
              ref={searchInputRef}
              placeholder={t("picker.searchModel")}
              value={searchQuery}
              onChange={(e) => {
                if (!isSearching) setSearchHeight(pickerContentRef.current?.offsetHeight ?? 0);
                setSearchQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (
                  showSidebar &&
                  !e.altKey &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  ((e.key === "ArrowLeft" && !e.shiftKey && searchQuery.length === 0) ||
                    (e.key === "Tab" && e.shiftKey))
                ) {
                  const sidebar = e.currentTarget
                    .closest("[data-model-picker-content]")
                    ?.querySelector("[data-model-picker-sidebar]");
                  const button =
                    sidebar?.querySelector<HTMLButtonElement>(
                      'button[aria-pressed="true"]:not(:disabled)',
                    ) ?? sidebar?.querySelector<HTMLButtonElement>("button:not(:disabled)");
                  if (button) {
                    e.preventDefault();
                    e.stopPropagation();
                    button.focus();
                    return;
                  }
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onRequestClose?.();
                  return;
                }
                if (e.key === "Enter" && highlightedModelKeyRef.current) {
                  (e as typeof e & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
                  e.preventDefault();
                  e.stopPropagation();
                  const model = parseModelPickerModelKey(highlightedModelKeyRef.current);
                  if (model) handleModelSelect(model.slug, model.instanceId);
                  return;
                }
                e.stopPropagation();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            />

            <div
              className={cn(
                "relative min-h-0 overflow-hidden pr-px",
                filteredItemKeys.length > 0 ? "flex-1" : "h-0",
              )}
            >
              <ComboboxList className="flex h-full flex-col gap-0.5 overscroll-y-contain py-1.5 pl-2 pr-px [&::-webkit-scrollbar-track]:my-2">
                {filteredItemKeys.map((modelKey, index) => {
                  const model = filteredModelByKey.get(modelKey);
                  if (!model) return null;
                  const disabledReason =
                    getModelDisabledReason?.(model.instanceId, model.slug) ?? null;
                  return (
                    <ModelListRow
                      key={modelKey}
                      index={index}
                      slug={model.slug}
                      name={model.name}
                      subProvider={model.subProvider}
                      instanceId={model.instanceId}
                      driverKind={model.driverKind}
                      providerDisplayName={model.instanceDisplayName}
                      isFavorite={favoritesSet.has(
                        providerModelKey(model.instanceId, model.slug),
                      )}
                      isSelected={modelKey === activeModelKey}
                      showProvider={rowsMixProviders || Boolean(model.subProvider)}
                      showNewBadge={model.badge === "new"}
                      unavailable={model.isUnavailable === true}
                      jumpLabel={jumpLabelByKey.get(modelKey) ?? null}
                      disabledReason={disabledReason}
                      onToggleFavorite={onToggleFavorite}
                    />
                  );
                })}
              </ComboboxList>
            </div>
            {providerSetupEntries.length > 0 ? (
              <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
                {providerSetupEntries.map((entry) => (
                  <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
                    <p className="line-clamp-3 text-muted-foreground">{entry.snapshot.message}</p>
                    <InlineButton
                      className="mt-1"
                      onClick={() => {
                        onRequestClose?.();
                        onOpenProviderSetup?.(entry.instanceId);
                      }}
                    >
                      {providerSetupEntries.length > 1
                        ? t("composer.t3.picker.setUpProvider", { name: entry.displayName })
                        : t("composer.t3.picker.openProviderSetup")}
                    </InlineButton>
                  </div>
                ))}
              </div>
            ) : (
              <ComboboxEmpty className="empty:h-0">
                {selectedInstanceId === "favorites" && !isSearching
                  ? t("composer.t3.picker.noFavorites")
                  : t("picker.noMatch")}
              </ComboboxEmpty>
            )}
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
