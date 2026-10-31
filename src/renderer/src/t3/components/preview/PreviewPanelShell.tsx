import {
  type CSSProperties,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { RESIZABLE_WIDTH_PROPERTY } from "../../hooks/useResizableWidth";
import {
  type PreviewPanelInlineSize,
  usePreviewPanelInlineSize,
} from "../../hooks/usePreviewPanelInlineSize";
import { cn } from "../../lib/utils";
import { RightPanelResizeHandle } from "./RightPanelResizeHandle";

export type PreviewPanelMode = "inline" | "sheet";

export interface PreviewPanelShellProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  open?: boolean;
  width: number;
  room?: number;
  dock?: number;
  span?: number;
  minWidth?: number;
  onWidth: (width: number) => void;
  label?: string;
  testId?: string;
  toggleSelector?: string;
  inlineSize?: PreviewPanelInlineSize;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  children: ReactNode;
}

const DEFAULT_TOGGLE_SELECTOR = '[data-testid="rp-hide"]';
const KEYBOARD_STEP = 16;

export function PreviewPanelShell(props: PreviewPanelShellProps) {
  if (props.inlineSize) return <PreviewPanelShellFrame {...props} inlineSize={props.inlineSize} />;
  return <ResizablePreviewPanelShell {...props} />;
}

function ResizablePreviewPanelShell(props: PreviewPanelShellProps) {
  const [overlayChosen, setOverlayChosen] = useState(false);
  const dock = props.dock;
  const minWidth = props.minWidth ?? 360;
  const shownWidth =
    dock === undefined || overlayChosen ? props.width : Math.min(props.width, Math.max(minWidth, dock));
  const { onWidth: storeWidth } = props;
  const onWidth = useCallback(
    (next: number) => {
      setOverlayChosen(dock !== undefined && next > dock);
      storeWidth(next);
    },
    [dock, storeWidth],
  );
  const inlineSize = usePreviewPanelInlineSize({
    enabled: props.mode === "inline" && !props.maximized,
    width: shownWidth,
    room: props.room,
    siblingMinWidth: dock !== undefined ? 0 : undefined,
    minWidth: props.minWidth,
    onWidth,
  });
  return <PreviewPanelShellFrame {...props} onWidth={onWidth} inlineSize={inlineSize} />;
}

function PreviewPanelShellFrame(props: PreviewPanelShellProps & { inlineSize: PreviewPanelInlineSize }) {
  const isInline = props.mode === "inline";
  const collapsible = isInline && props.open !== undefined;
  const open = props.open ?? true;
  const maximized = props.maximized ?? false;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const returnedFocus = useRef(false);
  const { width, handlers, observeRow } = props.inlineSize;
  const attachHost = useCallback(
    (host: HTMLDivElement | null) => {
      if (!host) {
        hostRef.current = null;
        return;
      }
      hostRef.current = host;
      const stopObservingRow = observeRow(host);
      return () => {
        hostRef.current = null;
        stopObservingRow();
      };
    },
    [observeRow],
  );
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !collapsible) return;
    return () => {
      if (!host.contains(host.ownerDocument.activeElement) && !returnedFocus.current) return;
      queueMicrotask(() => {
        if (host.ownerDocument.activeElement === host.ownerDocument.body) {
          host.ownerDocument
            .querySelector<HTMLButtonElement>(props.toggleSelector ?? DEFAULT_TOGGLE_SELECTOR)
            ?.focus();
        }
      });
    };
  }, [collapsible, hostRef, props.toggleSelector]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const collapsed = collapsible && !open;
    if (!collapsed) returnedFocus.current = false;
    if (collapsed && host.contains(host.ownerDocument.activeElement)) {
      const toggle = host.ownerDocument.querySelector<HTMLButtonElement>(
        props.toggleSelector ?? DEFAULT_TOGGLE_SELECTOR,
      );
      toggle?.focus();
      returnedFocus.current = toggle !== null && host.ownerDocument.activeElement === toggle;
    }
    host.toggleAttribute("inert", collapsed);
  }, [collapsible, open, hostRef, props.toggleSelector]);

  const minWidth = props.minWidth ?? 360;
  const maxWidth = Math.max(minWidth, props.inlineSize.maxWidth ?? props.room ?? width);
  const onHandleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowLeft") props.onWidth(Math.min(maxWidth, width + KEYBOARD_STEP));
    else if (event.key === "ArrowRight") props.onWidth(Math.max(minWidth, width - KEYBOARD_STEP));
    else if (event.key === "Home") props.onWidth(minWidth);
    else if (event.key === "End") props.onWidth(maxWidth);
    else return;
    event.preventDefault();
  };

  const floating = isInline && !maximized;
  const docked = isInline && (!maximized || props.span !== undefined);
  const overlay = floating && props.dock !== undefined && width > props.dock;
  const overlap = overlay && props.dock !== undefined && open ? Math.round(width - props.dock) : 0;
  useEffect(() => {
    const root = document.documentElement;
    if (overlap > 0) root.style.setProperty("--rp-overlap", `${overlap}px`);
    else root.style.removeProperty("--rp-overlap");
    return () => {
      root.style.removeProperty("--rp-overlap");
    };
  }, [overlap]);

  return (
    <div
      ref={attachHost}
      data-testid={props.testId}
      onKeyDown={props.onKeyDown}
      role="region"
      aria-label={props.label}
      data-workspace-unavailable={collapsible && !open ? "true" : undefined}
      data-preview-panel-mode={props.mode}
      data-preview-panel-maximized={maximized ? "true" : "false"}
      data-rp-overlay={overlay ? "" : undefined}
      className={cn(
        "t3-rp relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch",
        !docked && "bg-background",
        isInline ? (docked ? "z-(--z-panel) shrink-0" : "flex-1") : "w-full",
        docked && "w-[min(var(--rp-w),var(--rp-dock,var(--rp-w)))]",
        docked && collapsible && "transition-[width] duration-(--dur-sheet) ease-(--ease)",
        docked && collapsible && open && "starting:w-0",
        docked && collapsible && !open && "pointer-events-none w-0",
      )}
      style={
        isInline
          ? ({
              [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
              ...(docked && props.dock !== undefined ? { "--rp-dock": `${Math.max(0, Math.floor(props.dock))}px` } : null),
              ...(maximized && !docked ? { width: "100%" } : null),
            } as CSSProperties)
          : undefined
      }
    >
      {floating ? (
        <RightPanelResizeHandle
          handlers={handlers}
          label={props.label}
          value={width}
          min={minWidth}
          max={maxWidth}
          onKeyDown={onHandleKeyDown}
          className="left-[calc(min(var(--rp-w),var(--rp-dock,var(--rp-w)))-var(--rp-w)-0.25rem)]"
        />
      ) : null}
      <div
        data-rp-surface
        className={cn(
          "flex h-full min-h-0 flex-col",
          docked
            ? cn("absolute inset-y-0 right-0 border-l border-border", !maximized && "w-(--rp-w)")
            : "w-full",
          docked && collapsible && "transition-[translate] duration-(--dur-sheet) ease-(--ease)",
          docked && collapsible && open && "translate-x-0 starting:translate-x-(--rp-w)",
          docked && collapsible && !open && "translate-x-(--rp-w)",
        )}
        style={maximized && docked && props.span !== undefined ? { width: `${Math.floor(props.span)}px` } : undefined}
      >
        <div className={cn("h-full min-h-0 w-full", collapsible && "overflow-clip")}>
          <div className="flex h-full min-h-0 min-w-0 flex-col">{props.children}</div>
        </div>
      </div>
    </div>
  );
}
