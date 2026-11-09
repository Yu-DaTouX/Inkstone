import { memo, type PointerEventHandler } from "react";
import { CornerUpRight, ListPlus } from "lucide-react";
import { MorphIcon } from "../MorphIcon";
import { useT } from "../../../i18n";
import { useShortcutModifierState } from "../../adapters/shortcut-modifier";
import { resolveComposerDispatchMode } from "../../adapters/composer-dispatch";
import { Focusable, Spinner, TooltipTrigger, Tooltip, TooltipHint } from "../../../ui";
import "./ComposerPrimaryActions.css";

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
  const canOperate = true;

  const renderStopGenerationButton = () => (
    <TooltipTrigger key="interrupt">
      <Focusable><button type="button" className="t3-stop" {...pointerFocusProps} disabled={!canOperate} onClick={() => {
              if (canOperate) onInterrupt();
            }} aria-label={t("composer.t3.stopAria")}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </button></Focusable>
      <Tooltip><TooltipHint label={t("composer.t3.interrupt")} /></Tooltip>
    </TooltipTrigger>
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
      ? t(
          followUpBehavior === "queue"
            ? "composer.t3.queueClickHint"
            : "composer.t3.steerClickHint",
          { mod: "Alt" },
        )
      : submitLabel);

  const sendButton = (
    <button
      type="button"
      className="t3-send"
      {...pointerFocusProps}
      onClick={() => onSubmitMessage?.(isQueuing ? "followUp" : "steer")}
      disabled={isSendBusy || sendDisabledReason !== null || !hasSendableContent}
      aria-label={submitStatus ?? submitLabel}
    >
      {isSendBusy ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : isRunning ? (
        <MorphIcon from={CornerUpRight} to={ListPlus} active={isQueuing} className="t3-icon--md" />
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
    <TooltipTrigger key="submit">
      <Focusable excludeFromTabOrder><span className="t3-send-slot">{sendButton}</span></Focusable>
      <Tooltip><TooltipHint label={submitTooltip} /></Tooltip>
    </TooltipTrigger>
  );
});
