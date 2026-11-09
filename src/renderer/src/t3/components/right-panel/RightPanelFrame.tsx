import { useEffect, type ReactNode } from "react";

import { usePresence } from "../../../ui/motion-hooks";
import { cx } from "../../../ui/cx";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";
import { Sheet } from "../../../ui";
import type { PanelFrameProps, PanelMode } from "./model";
import "./RightPanelFrame.css";

export function RightPanelFrame(props: PanelFrameProps): ReactNode {
  const {
    mode,
    open,
    maximized = false,
    width,
    room,
    dock,
    span,
    minWidth,
    onWidth,
    label,
    tabbar,
    tabbarClassName,
    toggleSelector,
    onKeyDown,
    children,
    sheet,
    testId = "rp",
  } = props;
  const presence = usePresence(open, { animate: mode === "inline" && !maximized, exit: "sheet" });
  const sheetOpen = mode === "sheet" && open;

  useEffect(() => {
    if (!sheetOpen) return undefined;
    const root = document.documentElement;
    root.dataset.rpSheetOpen = "1";
    return () => {
      delete root.dataset.rpSheetOpen;
    };
  }, [sheetOpen]);

  const content = (panelMode: PanelMode): ReactNode => (
    <PreviewPanelShell
      mode={panelMode}
      open={open}
      maximized={panelMode === "inline" && maximized}
      width={width}
      room={room}
      dock={dock}
      span={span}
      minWidth={minWidth}
      onWidth={onWidth}
      label={label}
      testId={testId}
      toggleSelector={toggleSelector}
      onKeyDown={onKeyDown}
    >
      {tabbar ? (
        <div
          data-right-panel-tabbar
          className={cx(
            "t3-rp-frame__tabbar",
            tabbarClassName,
          )}
        >
          {tabbar}
        </div>
      ) : null}
      <div className="t3-rp-frame__content" data-right-panel-surface-content>
        {children}
      </div>
    </PreviewPanelShell>
  );

  if (mode === "sheet") {
    return (
      <Sheet
        isOpen={open}
        onOpenChange={(next) => {
          if (!next) sheet?.onClose();
        }}
        label={label}
        keepMounted
        transitionMs={sheet?.transitionMs}
        overlayClassName="rp-sheet-overlay"
        className="t3-rp-frame__sheet"
      >
        {content("sheet")}
      </Sheet>
    );
  }

  if (!open && !presence.closing) return null;

  return content("inline");
}
