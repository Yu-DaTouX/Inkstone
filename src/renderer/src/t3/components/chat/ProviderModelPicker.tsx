import { memo, useRef, useState } from "react";
import { Badge } from "../ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { ModelPickerContent, resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getDisplayModelName, getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";
import { shouldShowInstanceBadge } from "../../adapters/providers";
import type { ProviderInstanceEntry, ProviderInstanceId } from "../../adapters/contracts";
import { useT } from "../../../i18n";

export type ModelPickerSize = "sm" | "xs";

export function modelPickerTriggerClassName(size: ModelPickerSize, className?: string): string {
  return cn(
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-(--control-radius) border border-transparent text-base outline-none hover:bg-accent data-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-disabled:pointer-events-none data-disabled:opacity-64 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&:active:not([aria-haspopup])]:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:-mx-0.5 [&_svg[data-composer-control-icon]]:mx-0",
    "[&_:is([data-composer-control-label],[data-chat-provider-model-picker-label])]:[text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:[&_:is([data-composer-control-label],[data-chat-provider-model-picker-label])]:py-1.5",
    size === "xs"
      ? "h-7 gap-1 px-1.75 font-normal text-foreground/70 text-sm hover:text-foreground dark:text-muted-foreground sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5 [&_svg[data-composer-control-chevron]]:ms-0 [&_svg[data-composer-control-chevron]]:-me-1"
      : "h-7 gap-1.5 px-2 font-medium text-foreground/80 [&_svg:not([class*='text-'])]:text-muted-foreground hover:text-foreground sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
    "aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:hover:bg-accent/80",
    className,
  );
}

function lockBackgroundScroll(popup: HTMLElement | null) {
  if (!popup) return;
  const { documentElement, body } = document;
  const previousDocumentOverscrollBehavior = documentElement.style.overscrollBehavior;
  const previousBodyOverflow = body.style.overflow;
  const previousBodyPaddingRight = body.style.paddingRight;
  const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

  documentElement.style.overscrollBehavior = "contain";
  body.style.overflow = "hidden";
  if (scrollbarWidth > 0) {
    body.style.paddingRight = `${scrollbarWidth}px`;
  }

  const shouldAllowOverlayScroll = (target: EventTarget | null) => {
    return target instanceof Element && target.closest("[data-model-picker-content]");
  };
  const preventBackgroundWheel = (event: WheelEvent) => {
    if (shouldAllowOverlayScroll(event.target)) {
      return;
    }
    event.preventDefault();
  };
  const preventBackgroundTouchMove = (event: TouchEvent) => {
    if (shouldAllowOverlayScroll(event.target)) {
      return;
    }
    event.preventDefault();
  };

  document.addEventListener("wheel", preventBackgroundWheel, { capture: true, passive: false });
  document.addEventListener("touchmove", preventBackgroundTouchMove, {
    capture: true,
    passive: false,
  });

  return () => {
    document.removeEventListener("wheel", preventBackgroundWheel, { capture: true });
    document.removeEventListener("touchmove", preventBackgroundTouchMove, { capture: true });
    documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior;
    body.style.overflow = previousBodyOverflow;
    body.style.paddingRight = previousBodyPaddingRight;
  };
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
  floatingLayerProps?: Record<string, unknown>;
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
  };

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  const triggerTooltipContent = props.triggerLabel ?? triggerLabel;

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={props.triggerAriaLabel ?? props.triggerLabel ?? triggerLabel}
            data-chat-provider-model-picker="true"
            className={cn(
              modelPickerTriggerClassName(size),
              "min-w-0 shrink justify-between whitespace-nowrap",
              props.compact
                ? "max-w-42 shrink-0"
                : !props.isComposerOwned && "max-w-48 sm:max-w-56",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center",
            size === "xs" ? "gap-1" : "gap-1.5",
          )}
        >
          {activeEntry && props.triggerLabel === undefined ? (
            <span data-chat-provider-model-picker-icon className="contents">
              <ProviderInstanceIcon
                driverKind={activeEntry.driverKind}
                displayName={activeEntry.displayName}
                showBadge={showInstanceBadge}
                className="size-4"
                iconSize={16}
                badgeClassName={cn(
                  "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs",
                  size === "xs" && "shadow-none",
                )}
              />
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="min-w-0 flex-1 overflow-hidden truncate"
                  data-chat-provider-model-picker-label="true"
                />
              }
            >
              {props.triggerLabel ?? triggerTitle}
            </TooltipTrigger>
            <TooltipPopup side="top">{triggerTooltipContent}</TooltipPopup>
          </Tooltip>
          {selectedModel?.isUnavailable && props.triggerLabel === undefined ? (
            <Badge variant="outline" size="sm">
              {t("composer.t3.picker.unavailable")}
            </Badge>
          ) : null}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        {...(props.isComposerOwned ? props.floatingLayerProps : {})}
        ref={lockBackgroundScroll}
        initialFocus={searchInputRef}
        align="start"
        className="before:hidden"
        padding="none"
        touchBackdrop
      >
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
      </PopoverPopup>
    </Popover>
  );
});
