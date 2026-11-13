import { memo } from "react";
import { CheckIcon, StarIcon } from "../../../ui/icons";
import { getDisplayModelName, getProviderRowLabel } from "./providerIconUtils";
import { Badge, ComboboxItem, Focusable, IconButton, Tooltip, TooltipHint, TooltipTrigger } from "../../../ui";
import { cx } from "../../../ui/cx";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { useT } from "../../../i18n";
import type { ProviderDriverKind, ProviderInstanceId } from "../../adapters/contracts";
import "./ModelListRow.css";

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${String(Math.round(tokens / 100_000) / 10)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

export const ModelListRow = memo(function ModelListRow(props: {
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
      value={modelPickerModelKey(props.instanceId, props.slug)}
      selected={props.isSelected}
      disabled={Boolean(props.disabledReason)}
      className={cx(
        "t3-model-row",
        props.disabledReason && "t3-model-row--blocked",
      )}
    >
      <div className="t3-model-row__main">
        <div className="t3-model-row__title">
          <TooltipTrigger>
            <Focusable excludeFromTabOrder><div className="t3-model-row__name">
              {getDisplayModelName(model)}
            </div></Focusable>
            <Tooltip><TooltipHint label={getDisplayModelName(model)} /></Tooltip>
          </TooltipTrigger>
          {props.showNewBadge ? (
            <Badge tone="accent" className="t3-model-row__new" aria-label={t("composer.t3.picker.newModelLabel")}>
              {t("composer.t3.picker.newModel")}
            </Badge>
          ) : null}
          {props.unavailable ? (
            <Badge tone="neutral">
              {t("composer.t3.picker.unavailable")}
            </Badge>
          ) : null}
        </div>
        {props.showProvider && (
          <div className="t3-model-row__provider">
            <ProviderInstanceIcon
              driverKind={props.driverKind}
              displayName={props.providerDisplayName}
              iconSize={12}
            />
            <span className="t3-model-row__provider-name">
              {providerLabel}
            </span>
          </div>
        )}
      </div>

      <div className="t3-model-row__aside">
        {props.contextWindow ? (
          <Badge
            tone="neutral"
            aria-label={t("composer.t3.picker.contextWindow", {
              size: formatContextWindow(props.contextWindow),
            })}
            data-model-context-window
          >
            {formatContextWindow(props.contextWindow)}
          </Badge>
        ) : null}
        <TooltipTrigger>
          <IconButton data-t3-btn variant="ghost" size="md" excludeFromTabOrder onPress={() => {
                  props.onToggleFavorite(props.instanceId, props.slug);
                }} isDisabled={Boolean(props.disabledReason)} className="t3-model-row__favorite" onKeyDown={(event) => {
                  event.stopPropagation();
                }} aria-label={
                  props.isFavorite
                    ? t("composer.t3.picker.favoriteRemove")
                    : t("composer.t3.picker.favoriteAdd")
                }>
                <StarIcon
                  className={cx(
                    "t3-icon--xs",
                    props.isFavorite ? "t3-model-row__star--on" : "t3-model-row__star--off",
                  )}
                />
              </IconButton>
          <Tooltip><TooltipHint label={props.isFavorite ? t("composer.t3.picker.favoriteRemove") : t("composer.t3.picker.favoriteAdd")} /></Tooltip>
        </TooltipTrigger>
        <CheckIcon
          className={cx("t3-icon--sm", !props.isSelected && "t3-model-row__check--hidden")}
          aria-hidden="true"
        />
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <TooltipTrigger>
      <Focusable excludeFromTabOrder>{row}</Focusable>
      <Tooltip placement="left">
        <TooltipHint label={props.disabledReason} />
      </Tooltip>
    </TooltipTrigger>
  );
});
