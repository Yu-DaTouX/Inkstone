import { cn } from "../../lib/utils";
import type { ResizableWidthHandlers } from "../../hooks/useResizableWidth";

interface Props {
  handlers: ResizableWidthHandlers;
  className?: string;
  label?: string;
  value?: number;
  min?: number;
  max?: number;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
}

export function RightPanelResizeHandle({
  handlers,
  className,
  label,
  value,
  min,
  max,
  onKeyDown,
  onDoubleClick,
}: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      tabIndex={onKeyDown ? 0 : undefined}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      className={cn(
        "group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize select-none outline-none",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-border group-active:bg-primary/60"
      />
    </div>
  );
}
