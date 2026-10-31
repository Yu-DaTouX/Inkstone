import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useState } from "react";

export const RESIZABLE_WIDTH_PROPERTY = "--rp-w";

export interface ResizeBounds {
  readonly min: number;
  readonly max: number;
}

export interface ResizableWidthHandlers {
  readonly ref: (node: HTMLElement | null) => (() => void) | undefined;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
}

export interface UseResizableWidthOptions {
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly edge: "left" | "right";
  readonly onWidth: (width: number) => void;
}

interface ResizeSession {
  width: number;
  edge: "left" | "right";
  bounds: ResizeBounds;
  resize: (width: number) => number;
  finish: (width: number, moved: boolean) => void;
  cleanup?: (committed: boolean) => void;
}

interface ActiveDrag<T extends HTMLElement> {
  session: ResizeSession;
  target: T;
  pointerId: number;
  startX: number;
  pendingX: number;
  width: number;
  moved: boolean;
  frame: number | null;
  onBlur: () => void;
}

function clampToBounds(width: number, bounds: ResizeBounds): number {
  return Math.max(bounds.min, Math.min(bounds.max, width));
}

function createResizeDrag<T extends HTMLElement>() {
  let drag: ActiveDrag<T> | null = null;

  const flush = () => {
    const active = drag;
    if (!active) return;
    const delta = (active.pendingX - active.startX) * (active.session.edge === "left" ? -1 : 1);
    if (Math.abs(delta) > 2) active.moved = true;
    active.width = active.session.resize(
      clampToBounds(active.session.width + delta, active.session.bounds),
    );
  };

  const finish = (commit: boolean) => {
    const active = drag;
    if (!active) return;
    if (active.frame !== null) cancelAnimationFrame(active.frame);
    window.removeEventListener("blur", active.onBlur);
    if (commit) flush();
    drag = null;
    try {
      if (active.target.hasPointerCapture(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId);
      }
    } catch {}
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    active.session.cleanup?.(commit);
    if (commit) active.session.finish(active.width, active.moved);
  };

  const end = (event: ReactPointerEvent<T>, usePosition: boolean) => {
    const active = drag;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (usePosition) active.pendingX = event.clientX;
    finish(true);
  };

  return {
    ref: (node: T | null) => (node === null ? undefined : () => finish(false)),
    cancel: () => finish(false),
    refresh(bounds?: ResizeBounds) {
      if (!drag) return;
      if (bounds) drag.session.bounds = bounds;
      flush();
    },
    begin(
      event: ReactPointerEvent<T>,
      start: (event: ReactPointerEvent<T>) => ResizeSession | null,
    ) {
      if (event.button !== 0 || drag) return;
      const session = start(event);
      if (!session) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        session.cleanup?.(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const onBlur = () => finish(true);
      window.addEventListener("blur", onBlur);
      drag = {
        session,
        target: event.currentTarget,
        pointerId: event.pointerId,
        startX: event.clientX,
        pendingX: event.clientX,
        width: session.width,
        moved: false,
        frame: null,
        onBlur,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    onPointerMove(event: ReactPointerEvent<T>) {
      const active = drag;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      active.pendingX = event.clientX;
      if (Math.abs(event.clientX - active.startX) > 2) active.moved = true;
      if (active.frame !== null) return;
      active.frame = requestAnimationFrame(() => {
        active.frame = null;
        flush();
      });
    },
    onPointerUp: (event: ReactPointerEvent<T>) => end(event, true),
    onPointerCancel: (event: ReactPointerEvent<T>) => end(event, false),
    onLostPointerCapture: (event: ReactPointerEvent<T>) => end(event, false),
  };
}

export function useResizableWidth(options: UseResizableWidthOptions): {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
} {
  const { width, minWidth, maxWidth, edge, onWidth } = options;

  const clamp = (value: number): number => {
    if (!Number.isFinite(value)) return minWidth;
    return Math.max(minWidth, Math.min(maxWidth, value));
  };

  const clampedWidth = clamp(width);

  const [drag] = useState(createResizeDrag<HTMLElement>);

  const start = (event: ReactPointerEvent<HTMLElement>): ResizeSession | null => {
    const host = event.currentTarget.parentElement;
    host?.style.setProperty("transition-property", "none");
    document.documentElement.dataset.rpDragging = "1";
    const startWidth = clampedWidth;
    let written = startWidth;
    return {
      width: startWidth,
      edge,
      bounds: { min: minWidth, max: maxWidth },
      resize(nextWidth) {
        const rounded = Math.round(nextWidth);
        if (rounded !== written) {
          written = rounded;
          host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${rounded}px`);
          const dock = Number.parseFloat(host?.style.getPropertyValue("--rp-dock") ?? "");
          if (Number.isFinite(dock)) {
            host?.toggleAttribute("data-rp-overlay", rounded > dock);
            if (rounded > dock) document.documentElement.style.setProperty("--rp-overlap", `${rounded - dock}px`);
            else document.documentElement.style.removeProperty("--rp-overlap");
          }
        }
        return rounded;
      },
      finish(finalWidth, moved) {
        if (!moved && finalWidth === startWidth) return;
        onWidth(finalWidth);
      },
      cleanup(committed) {
        host?.style.removeProperty("transition-property");
        delete document.documentElement.dataset.rpDragging;
        if (!committed) {
          host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${startWidth}px`);
          const dock = Number.parseFloat(host?.style.getPropertyValue("--rp-dock") ?? "");
          if (Number.isFinite(dock)) {
            host?.toggleAttribute("data-rp-overlay", startWidth > dock);
            if (startWidth > dock) document.documentElement.style.setProperty("--rp-overlap", `${startWidth - dock}px`);
            else document.documentElement.style.removeProperty("--rp-overlap");
          }
        }
      },
    };
  };

  const { refresh } = drag;
  useLayoutEffect(() => refresh({ min: minWidth, max: maxWidth }), [refresh, minWidth, maxWidth]);

  return {
    width: clampedWidth,
    handlers: {
      ref: drag.ref,
      onPointerDown: (event) => drag.begin(event, start),
      onPointerMove: drag.onPointerMove,
      onPointerUp: drag.onPointerUp,
      onPointerCancel: drag.onPointerCancel,
      onLostPointerCapture: drag.onLostPointerCapture,
    },
  };
}
