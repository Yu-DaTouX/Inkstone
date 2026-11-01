import { Spinner as UiSpinner, type SpinnerSizeName } from "../../../ui";
import { cn } from "../../lib/utils";

function Spinner({
  className,
  size,
  tone,
}: {
  className?: string;
  size?: SpinnerSizeName;
  tone?: "current" | "muted";
  "aria-hidden"?: boolean | "true" | "false";
}) {
  return <UiSpinner size={size ?? "md"} className={cn(tone === "muted" && "opacity-60", className)} />;
}

export { Spinner };
