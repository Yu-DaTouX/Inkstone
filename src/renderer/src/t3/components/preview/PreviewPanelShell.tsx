import {
  type CSSProperties,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type ReactNode,
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
  const inlineSize = usePreviewPanelInlineSize({
    enabled: props.mode === "inline" && !props.maximized,
    width: props.width,
    room: props.room,
    minWidth: props.minWidth,
    onWidth: props.onWidth,
  });
  return <PreviewPanelShellFrame {...props} inlineSize={inlineSize} />;
}

function PreviewPanelShellFrame(props: PreviewPanelShellProps & { inlineSize: PreviewPanelInlineSize }) {
  const isInline = props.mode === "inline";
  const collapsible = isInline && props.open !== undefined;
  const open = props.open ?? true;
  const maximized = props.maximized ?? false;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const returnedFocus = useRef(false);
  const { width, handlers, observeRow } = props.inlineSize;
  const [widthTransition, setWidthTransition] = useState(() => ({
    open,
    width,
    maximized,
    enabled: true,
  }));
  if (
    widthTransition.open !== open ||
    widthTransition.width !== width ||
    widthTransition.maximized !== maximized
  ) {
    setWidthTransition({
      open,
      width,
      maximized,
      enabled: widthTransition.open !== open,
    });
  }
  const suppressWidthTransition = collapsible && !widthTransition.enabled;
  const attachHost = (host: HTMLDivElement) => {
    hostRef.current = host;
    const stopObservingRow = observeRow(host);
    return () => {
      hostRef.current = null;
      stopObservingRow();
    };
  };
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
  const maxWidth = Math.max(minWidth, width);
  const onHandleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowLeft") props.onWidth(Math.min(maxWidth, width + KEYBOARD_STEP));
    else if (event.key === "ArrowRight") props.onWidth(Math.max(minWidth, width - KEYBOARD_STEP));
    else if (event.key === "Home") props.onWidth(minWidth);
    else if (event.key === "End") props.onWidth(maxWidth);
    else return;
    event.preventDefault();
  };

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
      className={cn(
        "t3-rp relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background",
        isInline ? (maximized ? "flex-1" : "shrink-0 border-l border-border") : "w-full",
        collapsible && "transition-[width] duration-(--dur-sheet) ease-out",
        collapsible && open && "starting:w-0!",
        collapsible && !open && "pointer-events-none",
      )}
      style={
        isInline
          ? ({
              [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
              width: maximized ? "100%" : collapsible && !open ? "0px" : `var(${RESIZABLE_WIDTH_PROPERTY})`,
              transitionDuration: suppressWidthTransition ? "0ms" : undefined,
            } as CSSProperties)
          : undefined
      }
    >
      {isInline && !maximized ? (
        <RightPanelResizeHandle
          handlers={handlers}
          label={props.label}
          value={width}
          min={minWidth}
          max={maxWidth}
          onKeyDown={onHandleKeyDown}
        />
      ) : null}
      <div className={cn("h-full min-h-0 w-full", collapsible && "overflow-clip")}>
        <div
          className="flex h-full min-h-0 min-w-0 flex-col"
          style={
            collapsible && !maximized
              ? { width: `calc(var(${RESIZABLE_WIDTH_PROPERTY}) - 1px)` }
              : undefined
          }
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}
