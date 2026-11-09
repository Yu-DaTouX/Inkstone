import { ChevronDownIcon, XIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cx } from "../../../ui/cx";
import { IconButton, ScrollArea } from "../../../ui";
import "./ComposerBanner.css";

export type ComposerBannerVariant = "default" | "error" | "info" | "success" | "warning";

function Surface({
  variant = "default",
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: ComposerBannerVariant;
}) {
  return (
    <div
      data-composer-banner-surface="attached"
      data-variant={variant}
      className={cx("t3-banner-surface", className)}
      {...props}
    />
  );
}

function Attachment({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer-banner-attachment" className={cx("t3-banner-attachment", className)} {...props} />;
}

function Dock({ className, ...props }: ComponentProps<"div">) {
  return <Attachment className={cx("t3-banner-dock", className)} {...props} />;
}

function Column({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("t3-banner-column", className)} {...props} />;
}

function Root({
  className,
  density = "default",
  variant = "default",
  width = "fill",
  ...props
}: ComponentProps<"div"> & {
  density?: "default" | "comfortable" | "spacious";
  variant?: ComposerBannerVariant;
  width?: "fill" | "content";
}) {
  return (
    <Surface
      className={cx(
        "t3-banner",
        density !== "default" && `t3-banner--${density}`,
        width === "content" ? "t3-banner--content" : "t3-banner--fill",
        className,
      )}
      data-slot="composer-banner"
      data-composer-banner-width={width}
      variant={variant}
      {...props}
    />
  );
}

function Row({
  className,
  as: Tag = "div",
  layout = "inline",
  ...props
}: ComponentProps<"div"> & {
  as?: "div" | "li" | "button";
  layout?: "inline" | "wrap-actions" | "approval";
}) {
  const rowProps = {
    className: cx(
      "t3-banner__row",
      layout === "wrap-actions" && "t3-banner__row--wrap",
      layout === "approval" && "t3-banner__row--approval",
      className,
    ),
    "data-composer-banner-row": "true",
    "data-composer-banner-layout": layout,
  };
  const Element = Tag as "div";
  return <Element {...(Tag === "button" ? { type: "button" } : null)} {...rowProps} {...props} />;
}

function Icon({ className, ...props }: ComponentProps<"span">) {
  return <span aria-hidden data-slot="composer-banner-icon" className={cx("t3-banner__icon", className)} {...props} />;
}

function Content({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="composer-banner-content" className={cx("t3-banner__content", className)} {...props} />;
}

function Separator() {
  return (
    <span aria-hidden data-slot="composer-banner-separator" className="t3-banner__separator">
      ·
    </span>
  );
}

function Actions({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="composer-banner-actions" className={cx("t3-banner__actions", className)} {...props} />;
}

function Children({ className, as: Tag = "div", ...props }: ComponentProps<"div"> & { as?: "div" | "ul" }) {
  const Element = Tag as "div";
  return <Element {...(Tag === "ul" ? { role: "list" } : null)} className={cx("t3-banner__children", className)} {...props} />;
}

function Scroll({ className, children, ...props }: ComponentProps<typeof ScrollArea>) {
  return (
    <ScrollArea fade className={cx("t3-banner__scroll", className)} {...props}>
      <div className="t3-banner__scroll-body">{children}</div>
    </ScrollArea>
  );
}

function Count({ className, ...props }: ComponentProps<"span">) {
  return <span className={cx("t3-banner__count", className)} {...props} />;
}

function Body({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("t3-banner__body", className)} {...props} />;
}

function Dot({ className, ...props }: ComponentProps<"span">) {
  return <span className={cx("t3-banner__dot", className)} {...props} />;
}

function ToggleIcon({ expanded }: { expanded: boolean }) {
  return (
    <span aria-hidden className="ui-icon-btn t3-banner__toggle">
      <ChevronDownIcon className={cx("t3-icon--sm", !expanded && "t3-banner__chevron--collapsed")} />
    </span>
  );
}

function Dismiss({ className, children, ...props }: Omit<ComponentProps<typeof IconButton>, "children"> & { children?: ReactNode }) {
  return (
    <IconButton data-t3-btn variant="ghost" size="md" className={className} {...props}>
      {children ?? <XIcon className="t3-icon--sm" />}
    </IconButton>
  );
}

export const ComposerBanner = {
  Surface,
  Attachment,
  Dock,
  Column,
  Root,
  Row,
  Icon,
  Content,
  Separator,
  Actions,
  Children,
  Scroll,
  Count,
  Body,
  Dot,
  ToggleIcon,
  Dismiss,
};
