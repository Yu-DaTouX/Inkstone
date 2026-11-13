import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { StarIcon } from "../../../ui/icons";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { BareButton, Focusable, Toolbar, Tooltip, TooltipHint, TooltipTrigger } from "../../../ui";
import { cx } from "../../../ui/cx";
import {
  isProviderInstancePickerReady,
  shouldShowInstanceBadge,
} from "../../adapters/providers";
import type { ProviderInstanceEntry, ProviderInstanceId } from "../../adapters/contracts";
import { useT } from "../../../i18n";
import "./ModelPickerSidebar.css";

const PICKER_TOOLTIP_SIDE_OFFSET = 8;

function SidebarTooltipRow(props: { id: string; trigger: ReactElement<React.DOMAttributes<HTMLElement>, string>; label: string }) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} className="t3-model-sidebar__row" data-model-picker-provider={props.id}>
      <TooltipTrigger>
        <Focusable excludeFromTabOrder>{props.trigger}</Focusable>
        <Tooltip triggerRef={rowRef} placement="left" offset={PICKER_TOOLTIP_SIDE_OFFSET}>
          <TooltipHint label={props.label} />
        </Tooltip>
      </TooltipTrigger>
    </div>
  );
}

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  onFocusSearch: () => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  showFavorites?: boolean;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
}) {
  const t = useT();
  const handleSelect = (instanceId: ProviderInstanceId | "favorites") => {
    props.onSelectInstance(instanceId);
  };
  const showFavorites = props.showFavorites ?? true;
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) {
      return;
    }
    const selectedItem = Array.from(
      content.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find((item) => item.dataset.modelPickerProvider === props.selectedInstanceId);
    if (!selectedItem) {
      setSelectedIndicatorTop(null);
      return;
    }
    setSelectedIndicatorTop(selectedItem.offsetTop + selectedItem.offsetHeight / 2 - 10);
  }, [props.instanceEntries, props.selectedInstanceId, showFavorites]);

  return (
    <Toolbar
      className="t3-model-sidebar"
      data-model-picker-sidebar="true"
      aria-label={t("composer.t3.picker.providers")}
      orientation="vertical"
    >
      <div className="t3-model-sidebar__scroll" onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onFocusSearch();
          return;
        }
      }}>
        <div ref={sidebarContentRef} className="t3-model-sidebar__content">
          {selectedIndicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className="t3-model-sidebar__indicator"
              style={{ top: selectedIndicatorTop }}
            />
          ) : null}
          {showFavorites ? (
            <>
              <SidebarTooltipRow
                id="favorites"
                label={t("composer.t3.picker.favorites")}
                trigger={
                  <BareButton
                    className="t3-model-sidebar__item"
                    onPress={() => handleSelect("favorites")}
                    aria-label={t("composer.t3.picker.favorites")}
                    aria-pressed={props.selectedInstanceId === "favorites"}
                  >
                    <StarIcon className="t3-model-sidebar__favorites" size={22} aria-hidden />
                  </BareButton>
                }
              />
              <div className="t3-model-sidebar__divider" aria-hidden="true" />
            </>
          ) : null}

          {props.instanceEntries.map((entry) => {
            const isUnavailable = !isProviderInstancePickerReady(entry);
            const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
            const unavailableSelectionIsReachable =
              props.selectableUnavailableInstanceIds?.has(entry.instanceId) ?? false;
            const isDisabled =
              (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
            const isSelected = props.selectedInstanceId === entry.instanceId;
            const isHovered = hoveredInstanceId === entry.instanceId;
            const showInstanceBadge = shouldShowInstanceBadge();

            const tooltip = isContextDisabled
              ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
              : entry.displayName;

            const button = (
              <BareButton
                className={cx(
                  "t3-model-sidebar__item",
                  isDisabled && "t3-model-sidebar__item--disabled",
                )}
                onPress={() => !isDisabled && handleSelect(entry.instanceId)}
                onFocus={() => setHoveredInstanceId(entry.instanceId)}
                onBlur={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                isDisabled={isDisabled}
                aria-pressed={isSelected}
                aria-label={isUnavailable || isContextDisabled ? tooltip : entry.displayName}
              >
                <ProviderInstanceIcon
                  driverKind={entry.driverKind}
                  displayName={entry.displayName}
                  showBadge={showInstanceBadge}
                  iconSize={22}
                  indicatorBackground={
                    isHovered && !isDisabled
                      ? "var(--hover-main)"
                      : isSelected
                        ? "var(--bg)"
                        : "color-mix(in oklab, var(--hover-main) 30%, transparent)"
                  }
                />
              </BareButton>
            );

            const trigger = isDisabled ? (
              <span className="t3-model-sidebar__wrap">{button}</span>
            ) : (
              button
            );

            return <SidebarTooltipRow key={entry.instanceId} id={entry.instanceId} label={tooltip} trigger={trigger} />;
          })}
        </div>
      </div>
    </Toolbar>
  );
});
