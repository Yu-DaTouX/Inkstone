import type { ComponentProps } from "react";

import { cx } from "../../ui/cx";
import "./ComposerSurface.css";

function Shell({
  contextRow = false,
  className,
  ...props
}: ComponentProps<"div"> & { contextRow?: boolean }) {
  return (
    <div
      data-slot="composer-shell"
      data-context-row={contextRow || undefined}
      className={cx(
        "t3-composer-shell",
        className,
      )}
      {...props}
    />
  );
}

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cx(
        "t3-composer-host",
        className,
      )}
      {...props}
    />
  );
}

function Main({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cx(
        "t3-composer-main",
        className,
      )}
      {...props}
    />
  );
}

function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cx(
        "t3-composer-context",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
