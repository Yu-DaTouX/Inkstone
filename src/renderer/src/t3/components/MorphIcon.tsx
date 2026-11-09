import type { ComponentType, SVGProps } from "react";

import { cx } from "../../ui/cx";
import "./MorphIcon.css";

export function MorphIcon({
  from: From,
  to: To,
  active,
  className,
}: {
  from: ComponentType<SVGProps<SVGSVGElement>>;
  to: ComponentType<SVGProps<SVGSVGElement>>;
  active: boolean;
  className?: string;
}) {
  const layer = "t3-morph-icon__layer";
  return (
    <span
      aria-hidden="true"
      data-slot="morph-icon"
      className={cx("t3-morph-icon", className)}
    >
      <From className={cx(layer, active ? "t3-morph-icon__layer--hidden" : "t3-morph-icon__layer--shown")} />
      <To className={cx(layer, active ? "t3-morph-icon__layer--shown" : "t3-morph-icon__layer--hidden")} />
    </span>
  );
}
