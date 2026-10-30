import { memo, type PointerEventHandler } from "react";
import { CornerUpRight, ListPlus } from "lucide-react";
import { MorphIcon } from "../MorphIcon";
import { useT } from "../../../i18n";
import { useShortcutModifierState } from "../../adapters/shortcut-modifier";
import {
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
} from "../../adapters/composer-dispatch";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";

interface ComposerPrimaryActionsProps {
  isRunning: boolean;
  canInterrupt: boolean;
  followUpBehavior?: "queue" | "steer";
  canSteer?: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onSubmitMessage?: (mode: "steer" | "followUp") => void;
  onInterrupt: () => void;
}

const sendButtonClassName =
  "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none";

const stopButtonClassName =
  "flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none size-8 sm:h-8 sm:w-8 [&_svg]:pointer-events-none";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  isRunning,
  canInterrupt,
  followUpBehavior = "steer",
  canSteer = true,
  isSendBusy,
  sendDisabledReason,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  onSubmitMessage,
  onInterrupt,
}: ComposerPrimaryActionsProps) {
  const t = useT();
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const shortcutModifiers = useShortcutModifierState();
  const isQueuing =
    resolveComposerDispatchMode({
      running: isRunning,
      activeTurnDefault: followUpBehavior,
      canSteer,
      alternateModifier: shortcutModifiers.altKey,
    }) === "queue";
  const alternateAction = alternateComposerDispatchAction(followUpBehavior);
  const canOperate = true;

  const renderStopGenerationButton = () => (
    <Tooltip key="interrupt">
      <TooltipTrigger
        render={
          <button
            type="button"
            className={stopButtonClassName}
            {...pointerFocusProps}
            disabled={!canOperate}
            onClick={() => {
              if (canOperate) onInterrupt();
            }}
            aria-label={t("composer.t3.stopAria")}
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>{t("composer.t3.interrupt")}</TooltipPopup>
    </Tooltip>
  );

  if (canInterrupt && !hasSendableContent) return renderStopGenerationButton();

  const submitLabel = isQueuing
    ? t("composer.t3.queue")
    : isRunning
      ? t("composer.t3.steer")
      : t("composer.t3.submit");
  const submitStatus = sendDisabledReason ?? (isSendBusy ? t("composer.sending") : null);
  const submitTooltip =
    submitStatus ??
    (isRunning && canSteer
      ? t("composer.t3.steerClickHint", {
          action:
            followUpBehavior === "queue"
              ? t("composer.t3.queueAction")
              : t("composer.t3.steerAction"),
          mod: "Alt",
          alt:
            alternateAction === "queue"
              ? t("composer.t3.queueAction")
              : t("composer.t3.steerAction"),
        })
      : submitLabel);

  const sendButton = (
    <button
      type="button"
      className={cn(
        sendButtonClassName,
        "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover disabled:bg-foreground/12 disabled:text-muted-foreground",
      )}
      {...pointerFocusProps}
      onClick={() => onSubmitMessage?.(isQueuing ? "followUp" : "steer")}
      disabled={isSendBusy || sendDisabledReason !== null || !hasSendableContent}
      aria-label={submitStatus ?? submitLabel}
    >
      {isSendBusy ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : isRunning ? (
        <MorphIcon from={CornerUpRight} to={ListPlus} active={isQueuing} className="size-4" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  return (
    <Tooltip key="submit">
      <TooltipTrigger render={<span className="inline-flex" />}>{sendButton}</TooltipTrigger>
      <TooltipPopup>{submitTooltip}</TooltipPopup>
    </Tooltip>
  );
});
