import { memo, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogTrigger } from "react-aria-components";
import { BareButton, Badge, Focusable, Popover, Tooltip, TooltipHint, TooltipTrigger } from "../../../ui";
import { composerMenuClosed, composerFloatingLayerProps } from "./composerEventScope";
import { cx } from "../../../ui/cx";
import { ModelPickerContent, resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getDisplayModelName, getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";
import { shouldShowInstanceBadge } from "../../adapters/providers";
import type { ProviderInstanceEntry, ProviderInstanceId } from "../../adapters/contracts";
import { useT } from "../../../i18n";
import "./ProviderModelPicker.css";
import "./ComposerControl.css";

export type ModelPickerSize = "sm" | "xs";

export function modelPickerTriggerClassName(size: ModelPickerSize, className?: string): string {
  return cx("t3-ctl", size === "xs" ? "t3-ctl--xs" : "t3-ctl--sm", className);
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  activeInstanceId: ProviderInstanceId;
  model: string;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  favoriteKeys: ReadonlySet<string>;
  size?: ModelPickerSize;
  compact?: boolean;
  isComposerOwned?: boolean;
  disabled?: boolean;
  open?: boolean;
  triggerClassName?: string;
  triggerLabel?: string;
  triggerAriaLabel?: string;
  aside?: ReactNode;
  triggerBadge?: ReactNode;
  footer?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  onToggleFavorite: (instanceId: ProviderInstanceId, model: string) => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
}) {
  const t = useT();
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const size = props.size ?? "sm";

  const activeEntry =
    props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null;
  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  const selectedModel =
    resolveModelPickerSelectedModel({ model: props.model, options: selectedInstanceOptions }) ??
    selectedInstanceOptions[0];
  const triggerTitle = selectedModel
    ? getTriggerDisplayModelName(selectedModel, activeEntry?.driverKind)
    : props.model || t("composer.t3.picker.chooseModel");
  const triggerLabel = selectedModel
    ? `${getDisplayModelName(selectedModel)}${selectedModel.isUnavailable ? t("composer.t3.picker.unavailableSuffix") : ""}`
    : triggerTitle;
  const showInstanceBadge = activeEntry !== null && shouldShowInstanceBadge();

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
    if (!open && props.isComposerOwned) composerMenuClosed();
  };

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  const triggerTooltipContent = props.triggerLabel ?? triggerLabel;

  return (
    <DialogTrigger
      isOpen={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <BareButton
        aria-label={props.triggerAriaLabel ?? props.triggerLabel ?? triggerLabel}
        data-chat-provider-model-picker="true"
        className={cx(
          modelPickerTriggerClassName(size),
          "t3-model-trigger",
          props.compact
            ? "t3-model-trigger--compact"
            : !props.isComposerOwned && "t3-model-trigger--free",
          props.isComposerOwned && "t3-model-trigger--owned",
          props.triggerClassName,
        )}
        isDisabled={props.disabled}
      >
        <span
          className={cx("t3-model-trigger__row", size === "xs" && "t3-model-trigger__row--xs")}
        >
          {activeEntry && props.triggerLabel === undefined && !props.isComposerOwned ? (
            <span data-chat-provider-model-picker-icon className="t3-model-trigger__icon">
              <ProviderInstanceIcon
                driverKind={activeEntry.driverKind}
                displayName={activeEntry.displayName}
                local={activeEntry.local}
                showBadge={showInstanceBadge}
                iconSize={16}
                badgeClassName={cx("t3-provider-icon__badge--small", size === "xs" && "t3-provider-icon__badge--flat")}
              />
            </span>
          ) : null}
          {props.isComposerOwned ? (
            <span className="t3-model-trigger__label" data-chat-provider-model-picker-label="true">
              {props.triggerLabel ?? triggerTitle}
            </span>
          ) : (
            <TooltipTrigger>
              <Focusable excludeFromTabOrder>
                <span className="t3-model-trigger__label" data-chat-provider-model-picker-label="true">
                  {props.triggerLabel ?? triggerTitle}
                </span>
              </Focusable>
              <Tooltip placement="top">
                <TooltipHint label={triggerTooltipContent} />
              </Tooltip>
            </TooltipTrigger>
          )}
          {props.triggerBadge}
          {selectedModel?.isUnavailable && props.triggerLabel === undefined ? (
            <Badge tone="neutral">{t("composer.t3.picker.unavailable")}</Badge>
          ) : null}
        </span>
      </BareButton>
      <Popover
        {...(props.isComposerOwned ? composerFloatingLayerProps : {})}
        variant="panel"
        placement="top start"
        offset={4}
        className="t3-model-popover"
      >
        <Dialog aria-label={props.triggerAriaLabel ?? props.triggerLabel ?? triggerLabel} className="t3-model-dialog">
          <div
            className="composer-model-menu"
            data-composer-model-menu={props.aside || props.footer ? "true" : undefined}
          >
            <div className="composer-model-menu__body">
              <ModelPickerContent
                searchInputRef={searchInputRef}
                activeInstanceId={activeInstanceId}
                model={props.model}
                instanceEntries={props.instanceEntries}
                modelOptionsByInstance={props.modelOptionsByInstance}
                favoriteKeys={props.favoriteKeys}
                onRequestClose={() => setIsMenuOpen(false)}
                {...(props.onOpenProviderSetup ? { onOpenProviderSetup: props.onOpenProviderSetup } : {})}
                {...(props.getModelDisabledReason
                  ? { getModelDisabledReason: props.getModelDisabledReason }
                  : {})}
                onInstanceModelChange={handleInstanceModelChange}
                onToggleFavorite={props.onToggleFavorite}
              />
              {props.aside ? <div className="composer-model-menu__aside">{props.aside}</div> : null}
            </div>
            {props.footer ? <div className="composer-model-menu__foot">{props.footer}</div> : null}
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
});
