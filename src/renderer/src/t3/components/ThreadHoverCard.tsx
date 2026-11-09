import type { ReactNode } from "react";

import { Tooltip } from "../../ui";
import "./ThreadHoverCard.css";

export function ThreadHoverCardPopup({ children }: { children: ReactNode }) {
  return (
    <Tooltip placement="right top" offset={4} variant="card" className="t3-hover-card-tooltip">
      {children}
    </Tooltip>
  );
}

export function ThreadHoverCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="t3-hover-card">
      <div className="t3-hover-card__title">
        {title}
      </div>
      <div className="t3-hover-card__body">{children}</div>
      {footer}
    </div>
  );
}
