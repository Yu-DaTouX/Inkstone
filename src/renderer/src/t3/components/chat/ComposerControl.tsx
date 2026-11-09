import { forwardRef, type ComponentType, type SVGProps } from "react";

import { BareButton, type ButtonProps } from "../../../ui";
import { cx } from "../../../ui/cx";
import "./ComposerControl.css";

export type ComposerControlSize = "sm" | "xs";

function composerControlClassName(size: ComposerControlSize, className?: string) {
  return cx("t3-ctl", size === "xs" ? "t3-ctl--xs" : "t3-ctl--sm", className);
}

type ComposerControlProps = Omit<ButtonProps, "className" | "size" | "variant" | "icon" | "trailingIcon" | "tooltip" | "tooltipShortcut" | "tooltipPlacement"> & {
  size?: ComposerControlSize;
  className?: string | undefined;
};

export const ComposerControl = forwardRef<HTMLButtonElement, ComposerControlProps>(function ComposerControl(
  { className, size = "sm", ...props },
  ref,
) {
  return <BareButton {...props} ref={ref} className={composerControlClassName(size, className)} />;
});

export function ComposerControlIcon({
  icon: Icon,
  className,
  opticalSize = "default",
  size = "sm",
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  className?: string | undefined;
  opticalSize?: "default" | "large";
  size?: ComposerControlSize;
}) {
  return (
    <Icon
      aria-hidden="true"
      className={cx(
        "t3-ctl__icon",
        size === "xs" ? "t3-ctl__icon--xs" : opticalSize === "large" && "t3-ctl__icon--lg",
        className,
      )}
      data-composer-control-icon
    />
  );
}
