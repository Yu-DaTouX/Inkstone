import { useState } from "react";

import { InlineButton } from "../ui/button";
import { cn } from "../../lib/utils";

export interface SidebarUndoNotice {
  text: string;
  label: string;
  undo: () => void;
}

export function SidebarThreadUndoNotice({
  notice,
  className,
}: {
  notice: SidebarUndoNotice | null;
  className?: string;
}) {
  const [shownNotice, setShownNotice] = useState<SidebarUndoNotice | null>(notice);
  if (notice && notice !== shownNotice) setShownNotice(notice);
  const text = notice ?? shownNotice;
  if (!text) return null;

  return (
    <div
      role="group"
      aria-hidden={!notice}
      inert={!notice}
      onTransitionEnd={(event) => {
        if (!notice && event.target === event.currentTarget) setShownNotice(null);
      }}
      className={cn(
        "flex gap-1 px-2 text-2xs leading-6 text-sidebar-muted-foreground transition-opacity duration-200 ease-out starting:opacity-0",
        !notice && "opacity-0",
        className,
      )}
      data-testid="t3-sidebar-undo-notice"
    >
      <span className="min-w-0 truncate">{text.text},</span>
      <InlineButton onClick={text.undo}>{text.label}</InlineButton>
    </div>
  );
}
