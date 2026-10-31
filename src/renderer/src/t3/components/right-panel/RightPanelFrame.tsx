import { useEffect, type ReactNode } from "react";

import { usePresence } from "../../../ui/motion-hooks";
import { cn } from "../../lib/utils";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";
import { Sheet, SheetPopup } from "../ui/sheet";
import type { PanelFrameProps, PanelMode } from "./model";

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
      <div
        data-right-panel-tabbar
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pr-3 pl-2",
          tabbarClassName,
        )}
      >
        {tabbar}
      </div>
      <div className="flex min-h-0 flex-1 flex-col" data-right-panel-surface-content>
        {children}
      </div>
    </PreviewPanelShell>
  );

  if (mode === "sheet") {
    return (
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) sheet?.onClose();
        }}
      >
        <SheetPopup
          aria-label={label}
          side="right"
          showCloseButton={false}
          keepMounted
          transitionDurationMs={sheet?.transitionMs}
          data-rp-sheet
          className="h-full max-h-full w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0"
        >
          {content("sheet")}
        </SheetPopup>
      </Sheet>
    );
  }

  if (!open && !presence.closing) return null;

  return content("inline");
}
