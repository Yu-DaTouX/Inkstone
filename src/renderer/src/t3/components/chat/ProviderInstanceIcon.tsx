import { memo } from "react";

import type { ProviderDriverKind } from "../../adapters/contracts";
import { cn } from "../../lib/utils";
import { ModelBot } from "../../../patterns/ModelBot";
import { brandOfModel } from "../../../patterns/model-vendor";

export function providerInitials(displayName: string): string {
  const words = displayName.trim().split(/[\s._/-]+/u).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]!.slice(0, 1)}${words[1]!.slice(0, 1)}`.toUpperCase();
}

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  showBadge?: boolean;
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  indicatorBackground?: string;
  iconSize?: number;
}) {
  const brand = brandOfModel({ provider: props.driverKind, id: props.driverKind });
  const iconSize = props.iconSize ?? 16;
  return (
    <span
      className={cn(
        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      data-provider-brand={brand}
    >
      <ModelBot brand={brand} mood="icon" size={iconSize} className={cn(props.iconClassName)} />
      {props.showBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border bg-card px-0.5 text-4xs font-semibold leading-none text-muted-foreground shadow-sm",
            props.badgeClassName,
          )}
          style={{ borderColor: props.indicatorBackground ?? "var(--card)" }}
          aria-hidden
        >
          {providerInitials(props.displayName)}
        </span>
      ) : null}
    </span>
  );
});
