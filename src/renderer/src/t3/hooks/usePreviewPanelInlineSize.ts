import { useCallback, useState } from "react";

import { observeResize } from "../lib/observeResize";
import { type ResizableWidthHandlers, useResizableWidth } from "./useResizableWidth";

export interface PreviewPanelInlineSize {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
  readonly observeRow: (host: HTMLElement) => () => void;
}

const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_WIDTH_FRACTION = 0.7;
const SIBLING_COLUMN_MIN_WIDTH = 420;

export function usePreviewPanelInlineSize(options: {
  readonly enabled?: boolean | undefined;
  readonly width: number;
  readonly room?: number | undefined;
  readonly minWidth?: number | undefined;
  readonly onWidth: (width: number) => void;
  readonly container?: HTMLElement | null | undefined;
}): PreviewPanelInlineSize {
  const enabled = options.enabled ?? true;
  const minWidth = options.minWidth ?? PANEL_MIN_WIDTH;
  const container = options.container;
  const [measuredCap, setMeasuredCap] = useState(() =>
    maxWidthFor(typeof window === "undefined" ? 1280 : window.innerWidth),
  );
  const room = Number.isFinite(options.room) ? Math.floor(options.room as number) : Infinity;
  const maxWidth = Math.max(minWidth, Math.min(room, measuredCap));
  const { width, handlers } = useResizableWidth({
    width: options.width,
    minWidth,
    maxWidth,
    edge: "left",
    onWidth: options.onWidth,
  });
  const observeRow = useCallback(
    (host: HTMLElement) => {
      const row = container ?? (enabled ? host.parentElement : null) ?? null;
      const measure = () => {
        setMeasuredCap(maxWidthFor(window.innerWidth, row?.clientWidth));
      };
      measure();
      let frame = 0;
      const onResize = () => {
        if (frame !== 0) return;
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
      };
      window.addEventListener("resize", onResize);
      const stopObserving = row ? observeResize(row, measure) : undefined;
      return () => {
        window.removeEventListener("resize", onResize);
        if (frame !== 0) window.cancelAnimationFrame(frame);
        stopObserving?.();
      };
    },
    [container, enabled],
  );
  return { width, handlers, observeRow };
}

function maxWidthFor(viewportWidth: number, containerWidth?: number): number {
  const fractionCap = Math.floor(viewportWidth * PANEL_MAX_WIDTH_FRACTION);
  const containerCap =
    containerWidth === undefined ? Infinity : Math.floor(containerWidth) - SIBLING_COLUMN_MIN_WIDTH;
  return Math.max(PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap));
}
