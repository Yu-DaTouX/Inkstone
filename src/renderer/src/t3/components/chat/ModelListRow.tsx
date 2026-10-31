import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import { getDisplayModelName, getProviderRowLabel } from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { useT } from "../../../i18n";
import type { ProviderDriverKind, ProviderInstanceId } from "../../adapters/contracts";

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${String(Math.round(tokens / 100_000) / 10)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  slug: string;
  name: string;
  subProvider?: string | undefined;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  providerDisplayName: string;
  isFavorite: boolean;
  isSelected: boolean;
  showProvider: boolean;
  showNewBadge?: boolean;
  unavailable?: boolean;
  contextWindow?: number | undefined;
  disabledReason?: string | null;
  onToggleFavorite: (instanceId: ProviderInstanceId, slug: string) => void;
}) {
  const t = useT();
  const model = {
    slug: props.slug,
    name: props.name,
    subProvider: props.subProvider,
  };
  const providerLabel = getProviderRowLabel(props.providerDisplayName, props.subProvider);

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative min-h-10 w-full !min-w-0 max-w-full cursor-pointer py-1.5 sm:min-h-10",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 truncate font-medium text-[14px] leading-snug">
            {getDisplayModelName(model)}
          </div>
          {props.showNewBadge ? (
            <span
              className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-update-foreground"
              aria-label={t("composer.t3.picker.newModelLabel")}
            >
              {t("composer.t3.picker.newModel")}
            </span>
          ) : null}
          {props.unavailable ? (
            <Badge variant="outline" size="sm">
              {t("composer.t3.picker.unavailable")}
            </Badge>
          ) : null}
        </div>
        {props.showProvider && (
          <div className="mt-1 flex items-center gap-1.5">
            <ProviderInstanceIcon
              driverKind={props.driverKind}
              displayName={props.providerDisplayName}
              className="size-3"
              iconSize={12}
            />
            <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
              {providerLabel}
            </span>
          </div>
        )}
      </div>

      <div className="shrink-0 items-center gap-1.5 flex">
        {props.contextWindow ? (
          <Kbd
            className="tabular-nums"
            aria-label={t("composer.t3.picker.contextWindow", {
              size: formatContextWindow(props.contextWindow),
            })}
            data-model-context-window
          >
            {formatContextWindow(props.contextWindow)}
          </Kbd>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                className="-mr-1 shrink-0"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFavorite(props.instanceId, props.slug);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                disabled={Boolean(props.disabledReason)}
                aria-label={
                  props.isFavorite
                    ? t("composer.t3.picker.favoriteRemove")
                    : t("composer.t3.picker.favoriteAdd")
                }
              >
                <StarIcon
                  className={cn(
                    "size-3.5 sm:size-3",
                    props.isFavorite
                      ? "fill-current text-warning"
                      : "opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100 in-focus-visible:opacity-100 pointer-coarse:opacity-100",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            {props.isFavorite ? t("composer.t3.picker.favoriteRemove") : t("composer.t3.picker.favoriteAdd")}
          </TooltipPopup>
        </Tooltip>
        <CheckIcon
          className={cn("size-3.5", !props.isSelected && "invisible")}
          aria-hidden="true"
        />
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
