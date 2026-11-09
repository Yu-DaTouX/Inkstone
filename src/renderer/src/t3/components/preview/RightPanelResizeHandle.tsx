import { cx } from "../../../ui/cx";
import type { ResizableWidthHandlers } from "../../hooks/useResizableWidth";
import "./RightPanelResizeHandle.css";

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
      className={cx(
        "t3-rp-handle",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className="t3-rp-handle__grip"
      />
    </div>
  );
}
