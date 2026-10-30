import type { ComponentType, SVGProps } from "react";

import { cn } from "../lib/utils";

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
  const layer =
    "absolute inset-0 size-full transition-[opacity,scale] duration-150 ease-out motion-reduce:transition-none";
  return (
    <span
      aria-hidden="true"
      data-slot="morph-icon"
      className={cn("relative inline-flex size-4 items-center justify-center", className)}
    >
      <From className={cn(layer, active ? "scale-75 opacity-0" : "scale-100 opacity-100")} />
      <To className={cn(layer, active ? "scale-100 opacity-100" : "scale-75 opacity-0")} />
    </span>
  );
}
