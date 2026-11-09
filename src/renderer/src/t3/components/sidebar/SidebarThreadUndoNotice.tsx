import { useState } from "react";

import { Button } from "../../../ui";
import { cx } from "../../../ui/cx";
import "./SidebarThreadUndoNotice.css";

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
      className={cx(
        "t3-undo-notice",
        !notice && "t3-undo-notice--hidden",
        className,
      )}
      data-testid="t3-sidebar-undo-notice"
    >
      <span className="t3-undo-notice__text">{text.text},</span>
      <Button data-t3-btn variant="plain" size="sm" onPress={text.undo}>{text.label}</Button>
    </div>
  );
}
