import { BookmarkIcon } from "lucide-react";
import { memo } from "react";

import { cx } from "../../../ui/cx";
import { ComposerBanner } from "./ComposerBanner";
import "./ComposerStash.css";

export const ComposerStashBadge = memo(function ComposerStashBadge(props: {
  count: number;
  menuOpen: boolean;
  pulseKey: number;
  label: string;
  ariaLabel: string;
  onToggleMenu: () => void;
}) {
  if (props.count === 0) return null;
  const pulsed = props.pulseKey > 0;
  const count = (
    <ComposerBanner.Count
      key={props.pulseKey}
      className={cx(
        "t3-stash-badge__count",
        pulsed && "t3-stash-badge__count--pulse",
      )}
    >
      {props.count}
    </ComposerBanner.Count>
  );

  return (
    <ComposerBanner.Root
      density="comfortable"
      width="content"
      data-composer-shoulder-tab
      className="t3-stash-badge"
    >
      <ComposerBanner.Row
        as="button"
        data-prompt-stash-badge="true"
        aria-label={props.ariaLabel}
        aria-expanded={props.menuOpen}
        className={cx(
          "t3-stash-badge__row",
          pulsed && (props.pulseKey % 2 === 0 ? "t3-stash-badge__row--pulse-b" : "t3-stash-badge__row--pulse-a"),
        )}
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onToggleMenu}
      >
        <ComposerBanner.Icon>
          <BookmarkIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>{props.label}</ComposerBanner.Content>
        <ComposerBanner.Actions>{count}</ComposerBanner.Actions>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
});
