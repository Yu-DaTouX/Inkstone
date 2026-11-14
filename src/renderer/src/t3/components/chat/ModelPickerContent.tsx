import { memo, useState, useEffect, useEffectEvent, useRef, type RefObject } from "react";
import { ChevronRightIcon, StarIcon } from "../../../ui/icons";
import { ModelListRow } from "./ModelListRow";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { legacyModelSlugs, modelVendor } from "./modelPickerGroups";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { modelPickerModelKey, parseModelPickerModelKey } from "./modelPickerKeys";
import { rankModelPickerSearch } from "./modelPickerSearch";
import { Button, Combobox, ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxSearchInput } from "../../../ui";
import type { ModelEsque } from "./providerIconUtils";
import { cx } from "../../../ui/cx";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
} from "../../adapters/providers";
import { providerModelKey, sortProviderModelItems } from "../../adapters/composer-model";
import { MODEL_JUMP_LIMIT } from "../../adapters/shortcuts";
import type { ProviderInstanceEntry, ProviderInstanceId } from "../../adapters/contracts";
import { useT } from "../../../i18n";
import { useNarrowModelMenu } from "./ComposerModelMenuPanels";
import "./ModelPickerContent.css";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  instanceId: ProviderInstanceId;
  driverKind: string;
  local?: boolean | undefined;
  instanceDisplayName: string;
  isUnavailable?: boolean | undefined;
  contextWindow?: number | undefined;
};

const ONE_LINE_ROW_UNITS = 10;
const TWO_LINE_ROW_UNITS = 13;
const HEADER_ROW_UNITS = 7;
const ROW_SEPARATOR_UNITS = 0.5;
const LIST_CHROME_UNITS = 15.5;
const MAX_LIST_UNITS = 108;
const SIDEBAR_ITEM_UNITS = 11;
const SIDEBAR_CHROME_UNITS = 2;
const LEGACY_ROW_KEY = "__legacy__";
const OTHERS_GROUP_KEY = "__others__";

type ModelPickerListEntry =
  | { kind: "header"; key: string; label: string; vendorKey: string | null; favorites?: boolean }
  | { kind: "model"; model: ModelPickerItem }
  | { kind: "legacy"; count: number };

function buildGroupedEntries(input: {
  models: ReadonlyArray<ModelPickerItem>;
  isFavorite: (model: ModelPickerItem) => boolean;
  isActive: (model: ModelPickerItem) => boolean;
  legacyExpanded: boolean;
  favoritesLabel: string;
  othersLabel: string;
}): ModelPickerListEntry[] {
  const favorites = input.models.filter(input.isFavorite);
  const rest = input.models.filter((model) => !input.isFavorite(model));
  const legacy = legacyModelSlugs(
    rest.map((model) => model.slug),
    (slug) => rest.some((model) => model.slug === slug && input.isActive(model)),
  );
  const current = rest.filter((model) => !legacy.has(model.slug));
  const groups = new Map<string, { label: string; vendorKey: string | null; models: ModelPickerItem[] }>();
  for (const model of current) {
    const vendor = modelVendor(model.slug);
    const key = vendor?.key ?? "";
    const group = groups.get(key);
    if (group) group.models.push(model);
    else
      groups.set(key, {
        label: vendor?.label ?? model.instanceDisplayName,
        vendorKey: vendor?.key ?? null,
        models: [model],
      });
  }
  const singles = [...groups].filter(([, group]) => group.models.length === 1);
  if (singles.length > 1 && singles.length < groups.size) {
    for (const [key] of singles) groups.delete(key);
    groups.set(OTHERS_GROUP_KEY, {
      label: input.othersLabel,
      vendorKey: null,
      models: singles.flatMap(([, group]) => group.models),
    });
  }
  const withHeaders = groups.size > 1;
  const entries: ModelPickerListEntry[] = [];
  if (favorites.length > 0) {
    if (withHeaders)
      entries.push({ kind: "header", key: "favorites", label: input.favoritesLabel, vendorKey: null, favorites: true });
    for (const model of favorites) entries.push({ kind: "model", model });
  }
  for (const [key, group] of groups) {
    if (withHeaders) entries.push({ kind: "header", key, label: group.label, vendorKey: group.vendorKey });
    for (const model of group.models) entries.push({ kind: "model", model });
  }
  const legacyModels = rest.filter((model) => legacy.has(model.slug));
  if (legacyModels.length > 0) {
    entries.push({ kind: "legacy", count: legacyModels.length });
    if (input.legacyExpanded) for (const model of legacyModels) entries.push({ kind: "model", model });
  }
  return entries;
}

function entryUnits(
  entries: ReadonlyArray<ModelPickerListEntry>,
  isTwoLine: (model: ModelPickerItem) => boolean,
): number {
  let units = 0;
  for (const entry of entries) {
    if (units > 0) units += ROW_SEPARATOR_UNITS;
    units +=
      entry.kind === "header"
        ? HEADER_ROW_UNITS
        : entry.kind === "legacy"
          ? ONE_LINE_ROW_UNITS
          : isTwoLine(entry.model)
            ? TWO_LINE_ROW_UNITS
            : ONE_LINE_ROW_UNITS;
  }
  return units;
}

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
  const narrow = useNarrowModelMenu();
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
    () =>
      favoritesSet.has(providerModelKey(props.activeInstanceId, activeModelSlug))
        ? "favorites"
        : props.activeInstanceId,
  );
  const [searchHeight, setSearchHeight] = useState(0);
  const [legacyExpanded, setLegacyExpanded] = useState(false);
  useEffect(() => {
    if (!legacyExpanded) return;
    pickerContentRef.current
      ?.querySelector<HTMLElement>("[data-model-picker-legacy]")
      ?.scrollIntoView({ block: "start" });
  }, [legacyExpanded]);

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
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          instanceId,
          driverKind: entry.driverKind,
          ...(entry.local ? { local: true } : {}),
          instanceDisplayName: entry.displayName,
        });
      }
    }
    return out;
  })();

  const isSearching = searchQuery.trim().length > 0;
  const rowsMixProviders = isSearching || selectedInstanceId === "favorites";
  const isFavoriteModel = (model: ModelPickerItem) =>
    favoritesSet.has(providerModelKey(model.instanceId, model.slug));
  const isActiveModel = (model: ModelPickerItem) =>
    modelPickerModelKey(model.instanceId, model.slug) === activeModelKey;
  const groupedEntriesFor = (models: ReadonlyArray<ModelPickerItem>, expanded: boolean) =>
    buildGroupedEntries({
      models: sortProviderModelItems(models, {
        favoriteModelKeys: favoritesSet,
        groupFavorites: true,
        instanceOrder: [],
      }),
      isFavorite: isFavoriteModel,
      isActive: isActiveModel,
      legacyExpanded: expanded,
      favoritesLabel: t("composer.t3.picker.favorites"),
      othersLabel: t("composer.t3.picker.otherVendors"),
    });
  const tallestTabUnits = (() => {
    const favorites = flatModels.filter(isFavoriteModel);
    let tallest = entryUnits(
      favorites.map((model) => ({ kind: "model", model }) as const),
      () => true,
    );
    const byInstance = new Map<ProviderInstanceId, ModelPickerItem[]>();
    for (const model of flatModels) {
      const list = byInstance.get(model.instanceId);
      if (list) list.push(model);
      else byInstance.set(model.instanceId, [model]);
    }
    for (const models of byInstance.values()) {
      tallest = Math.max(
        tallest,
        entryUnits(groupedEntriesFor(models, false), (model) => Boolean(model.subProvider)),
      );
    }
    return tallest;
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

  const listEntries: ModelPickerListEntry[] =
    isSearching || selectedInstanceId === "favorites"
      ? filteredModels.map((model) => ({ kind: "model", model }) as const)
      : groupedEntriesFor(filteredModels, legacyExpanded);
  const filteredItemKeys = listEntries.flatMap((entry) =>
    entry.kind === "model"
      ? [modelPickerModelKey(entry.model.instanceId, entry.model.slug)]
      : entry.kind === "legacy"
        ? [LEGACY_ROW_KEY]
        : [],
  );

  const listUnits = (units: number) =>
    `min(calc(0.25rem * ${units + LIST_CHROME_UNITS} + 1px), calc(0.25rem * ${MAX_LIST_UNITS}))`;
  const sidebarUnits = showSidebar
    ? (sidebarInstanceEntries.length + 1) * SIDEBAR_ITEM_UNITS + SIDEBAR_CHROME_UNITS
    : 0;
  const currentTabUnits = Math.max(
    ONE_LINE_ROW_UNITS,
    sidebarUnits - LIST_CHROME_UNITS,
    entryUnits(listEntries, (model) => rowsMixProviders || Boolean(model.subProvider)),
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
    <>
      <WindowKeyDownListener onKeyDown={onWindowKeyDown} />
      <div
        ref={pickerContentRef}
        className="t3-model-picker"
        style={
          isSearching
            ? { height: searchHeight }
            : narrow
              ? { height: listUnits(currentTabUnits) }
              : { minHeight: listUnits(tallestTabUnits) }
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

        <Combobox
          keys={filteredItemKeys}
          autoHighlight
          onHighlightChange={(modelKey) => {
            highlightedModelKeyRef.current = modelKey;
          }}
          onValueChange={(value) => {
            if (value === LEGACY_ROW_KEY) {
              setLegacyExpanded((expanded) => !expanded);
              return;
            }
            const model = parseModelPickerModelKey(value);
            if (model) handleModelSelect(model.slug, model.instanceId);
          }}
        >
          <div
            className={cx(
              "t3-model-picker__main",
              showSidebar && "t3-model-picker__main--sided",
            )}
          >
            <ComboboxSearchInput
              ref={searchInputRef}
              autoFocus
              aria-label={t("picker.searchModel")}
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
                  e.preventDefault();
                  e.stopPropagation();
                  if (highlightedModelKeyRef.current === LEGACY_ROW_KEY) {
                    setLegacyExpanded((expanded) => !expanded);
                    return;
                  }
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
              className={cx(
                "t3-model-picker__list-frame",
                filteredItemKeys.length > 0 ? "t3-model-picker__list-frame--filled" : "t3-model-picker__list-frame--empty",
              )}
            >
              <ComboboxList aria-label={t("picker.searchModel")} className="t3-model-picker__list">
                {(() => {
                  return listEntries.map((entry) => {
                    if (entry.kind === "header") {
                      return (
                        <div
                          key={`header:${entry.key}`}
                          role="presentation"
                          data-model-picker-group={entry.key}
                          className="t3-model-picker__group"
                        >
                          {entry.favorites ? (
                            <StarIcon className="t3-icon--sm t3-model-picker__group-star" aria-hidden />
                          ) : (
                            <ProviderInstanceIcon
                              driverKind={entry.vendorKey ?? ""}
                              displayName={entry.label}
                              iconSize={14}
                            />
                          )}
                          <span className="t3-model-picker__group-label">{entry.label}</span>
                        </div>
                      );
                    }
                    if (entry.kind === "legacy") {
                      return (
                        <ComboboxItem
                          key={LEGACY_ROW_KEY}
                          value={LEGACY_ROW_KEY}
                          aria-expanded={legacyExpanded}
                          data-model-picker-legacy="true"
                          className="t3-model-picker__legacy"
                        >
                          <span className="t3-model-picker__legacy-label">
                            {t("composer.t3.picker.legacyModels", { count: entry.count })}
                          </span>
                          <ChevronRightIcon
                            className={cx(
                              "t3-icon--md t3-model-picker__legacy-chevron",
                              legacyExpanded && "t3-model-picker__legacy-chevron--open",
                            )}
                            aria-hidden
                          />
                        </ComboboxItem>
                      );
                    }
                    const model = entry.model;
                    const modelKey = modelPickerModelKey(model.instanceId, model.slug);
                    const disabledReason =
                      getModelDisabledReason?.(model.instanceId, model.slug) ?? null;
                    return (
                      <ModelListRow
                        key={modelKey}
                        slug={model.slug}
                        name={model.name}
                        subProvider={model.subProvider}
                        instanceId={model.instanceId}
                        driverKind={model.driverKind}
                        local={model.local}
                        providerDisplayName={model.instanceDisplayName}
                        isFavorite={isFavoriteModel(model)}
                        isSelected={modelKey === activeModelKey}
                        showProvider={rowsMixProviders || Boolean(model.subProvider)}
                        showNewBadge={model.badge === "new"}
                        unavailable={model.isUnavailable === true}
                        contextWindow={model.contextWindow}
                        disabledReason={disabledReason}
                        onToggleFavorite={onToggleFavorite}
                      />
                    );
                  });
                })()}
              </ComboboxList>
            </div>
            {providerSetupEntries.length > 0 ? (
              <div className="t3-model-picker__setup">
                {providerSetupEntries.map((entry) => (
                  <div key={entry.instanceId} className="t3-model-picker__setup-item">
                    <p className="t3-model-picker__setup-message">{entry.snapshot.message}</p>
                    <Button data-t3-btn
                      variant="plain"
                      size="sm"
                      className="t3-model-picker__setup-action"
                      onPress={() => {
                        onRequestClose?.();
                        onOpenProviderSetup?.(entry.instanceId);
                      }}
                    >
                      {providerSetupEntries.length > 1
                        ? t("composer.t3.picker.setUpProvider", { name: entry.displayName })
                        : t("composer.t3.picker.openProviderSetup")}
                    </Button>
                  </div>
                ))}
              </div>
            ) : filteredItemKeys.length === 0 ? (
              <ComboboxEmpty className="t3-model-picker__empty">
                {selectedInstanceId === "favorites" && !isSearching
                  ? t("composer.t3.picker.noFavorites")
                  : t("picker.noMatch")}
              </ComboboxEmpty>
            ) : null}
          </div>
        </Combobox>
      </div>
    </>
  );
});
