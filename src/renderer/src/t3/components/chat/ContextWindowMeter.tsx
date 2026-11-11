import { Minimize2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DialogTrigger } from "react-aria-components";

import { useT } from "../../../i18n";
import { formatContextWindowTokens, type ContextWindowSnapshot } from "../../adapters/context";
import { Button, IconButton, Popover } from "../../../ui";
import { composerFloatingLayerProps } from "./composerEventScope";
import { formatContextWindowCost } from "./ContextWindowMeter.logic";
import "./ContextWindowMeter.css";

const HOVER_OPEN_DELAY_MS = 150;

function useHoverPopover(closeDelay: number) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const schedule = (next: boolean, delay: number) => {
    clear();
    if (delay <= 0) {
      setOpen(next);
      return;
    }
    timer.current = window.setTimeout(() => setOpen(next), delay);
  };
  return {
    open,
    setOpen: (next: boolean) => {
      clear();
      setOpen(next);
    },
    hoverEnter: () => schedule(true, HOVER_OPEN_DELAY_MS),
    hoverLeave: () => schedule(false, closeDelay),
    keepOpen: clear,
  };
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const t = useT();
  const { usage, onCompact, compactDisabled, compactDisabledReason } = props;
  const estimatePrefix = usage.estimated ? "≈" : "";
  const percentage = formatPercentage(usage.usedPercentage);
  const usedPercentage = percentage === null ? null : `${estimatePrefix}${percentage}`;
  const usedTokens = `${estimatePrefix}${formatContextWindowTokens(usage.usedTokens)}`;
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--fail)"
    : "color-mix(in oklab, var(--fg3) 72%, transparent)";

  const hover = useHoverPopover(onCompact ? 150 : 0);

  return (
    <DialogTrigger isOpen={hover.open} onOpenChange={hover.setOpen}>
          <IconButton data-t3-btn variant="ghost" size="md" onHoverStart={hover.hoverEnter} onHoverEnd={hover.hoverLeave} className="t3-ctx-meter" data-testid="composer-context-meter" aria-label={
              usage.maxTokens !== null && usedPercentage
                ? t("composer.t3.contextUsageAria", { pct: usedPercentage })
                : t("composer.t3.contextTokensAria", {
                    n: usedTokens,
                  })
            }>
            <span className="t3-ctx-meter__ring">
              <svg
                viewBox="0 0 24 24"
                className="t3-ctx-meter__svg"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  className="t3-ctx-meter__track"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap={normalizedPercentage < 5 ? "butt" : "round"}
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="t3-ctx-meter__arc"
                />
              </svg>
            </span>
          </IconButton>
      <Popover
        {...composerFloatingLayerProps}
        variant="panel"
        isNonModal
        placement="top end"
        offset={4}
        className="t3-ctx-popover"
        data-testid="composer-context-popover"
      >
        <div className="t3-ctx-popover__body" onPointerEnter={hover.keepOpen} onPointerLeave={hover.hoverLeave}>
          <div className="t3-ctx-popover__head">
            <div className="t3-ctx-popover__title">
              {usage.cappedByAutoCompact ? t("ctx.toAutoCompact") : t("ctx.window")}
            </div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="t3-ctx-popover__usage">
                <span>{usedPercentage}</span>
                <span className="t3-ctx-popover__dot">·</span>
                <span>
                  {usedTokens}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="t3-ctx-popover__usage">
                {usedTokens}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="t3-ctx-popover__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label={t("composer.t3.contextUsageBar")}
            >
              <div
                className="t3-ctx-popover__fill"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {usage.cappedByAutoCompact && usage.modelWindow !== null ? (
            <div className="t3-ctx-popover__row">
              <span>{t("ctx.window")}</span>
              <span className="t3-ctx-popover__value">
                {formatContextWindowTokens(usage.modelWindow)}
              </span>
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="t3-ctx-popover__row">
              <span>{t("composer.t3.totalProcessed")}</span>
              <span className="t3-ctx-popover__value">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.cost != null ? (
            <div className="t3-ctx-popover__row">
              <span>{t("composer.t3.cost")}</span>
              <span className="t3-ctx-popover__value">
                {formatContextWindowCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button data-t3-btn variant="secondary" isDisabled={compactDisabled} onPress={onCompact} className="t3-ctx-popover__compact" title={compactDisabled ? (compactDisabledReason ?? undefined) : undefined} data-testid="composer-context-compact">
                <Minimize2Icon aria-hidden="true" />
                {t("status.compact")}
              </Button>
            </>
          ) : null}
        </div>
      </Popover>
    </DialogTrigger>
  );
}

export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="t3-ctx-meter__placeholder" />;
}
