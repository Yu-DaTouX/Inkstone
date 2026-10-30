import type { ReactNode } from "react";

import { usePresence } from "../../../ui/motion-hooks";
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
    minWidth,
    onWidth,
    label,
    tabbar,
    children,
    sheet,
    testId = "rp",
  } = props;
  const presence = usePresence(open, { animate: mode === "inline" && !maximized, exit: "sheet" });

  const content = (panelMode: PanelMode): ReactNode => (
    <PreviewPanelShell
      mode={panelMode}
      open={open}
      maximized={panelMode === "inline" && maximized}
      width={width}
      room={room}
      minWidth={minWidth}
      onWidth={onWidth}
      label={label}
      testId={testId}
    >
      <div
        data-right-panel-tabbar
        className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pr-3 pl-2"
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
          className="w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0"
        >
          {content("sheet")}
        </SheetPopup>
      </Sheet>
    );
  }

  if (!open && !presence.closing) return null;

  return content("inline");
}
