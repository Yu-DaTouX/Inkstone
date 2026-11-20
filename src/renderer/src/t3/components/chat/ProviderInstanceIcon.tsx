import { memo } from "react";

import { ANTIGRAVITY_PROVIDER } from "../../../../../shared/antigravity";
import type { ProviderDriverKind } from "../../adapters/contracts";
import type { ModelEsque } from "./providerIconUtils";
import { cx } from "../../../ui/cx";
import { ModelBot } from "../../../patterns/ModelBot";
import { brandOfModel } from "../../../patterns/model-vendor";
import { providerFavicon } from "../../../patterns/provider-favicon";
import "./ProviderInstanceIcon.css";

export function providerInitials(displayName: string): string {
  const words = displayName.trim().split(/[\s._/-]+/u).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]!.slice(0, 1)}${words[1]!.slice(0, 1)}`.toUpperCase();
}

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  local?: boolean | undefined;
  model?: Pick<ModelEsque, 'slug' | 'name'> | undefined;
  showBadge?: boolean;
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  indicatorBackground?: string;
  iconSize?: number;
}) {
  const antigravity = props.driverKind === ANTIGRAVITY_PROVIDER;
  const model = antigravity ? props.model : undefined;
  const id = model?.slug ?? props.driverKind;
  const identified = brandOfModel({ provider: props.driverKind, id });
  const brand = model && identified === "pi"
    ? brandOfModel({ provider: props.driverKind, id: model.name })
    : identified;
  const iconSize = props.iconSize ?? 16;
  const favicon = model ? null : providerFavicon(props.driverKind, props.local === true);
  return (
    <span
      className={cx(
        "t3-provider-icon",
        props.className,
      )}
      data-provider-brand={antigravity && !model ? ANTIGRAVITY_PROVIDER : brand}
    >
      {favicon ? (
        <img
          src={favicon}
          alt=""
          width={iconSize}
          height={iconSize}
          draggable={false}
          data-provider-favicon
          className={cx("t3-provider-icon__img", props.iconClassName)}
          style={{ width: iconSize, height: iconSize }}
        />
      ) : (
        <ModelBot brand={brand} mood="icon" size={iconSize} className={cx(props.iconClassName)} />
      )}
      {props.showBadge ? (
        <span
          className={cx(
            "t3-provider-icon__badge",
            props.badgeClassName,
          )}
          style={{ borderColor: props.indicatorBackground ?? "var(--surface)" }}
          aria-hidden
        >
          {providerInitials(props.displayName)}
        </span>
      ) : null}
    </span>
  );
});
