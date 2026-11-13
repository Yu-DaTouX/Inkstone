import { MoreHorizontal, PanelLeft, Unplug } from "../../../ui/icons";
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useT } from "../../../i18n";
import { cx } from "../../../ui/cx";
import { BrandMark } from "../../../features/sidebar/BrandMark";
import { Avatar, Button, Focusable, IconButton, Menu, MenuItem, Popover, StatusDot, Tooltip, TooltipHint, TooltipTrigger, type StatusDotKind } from "../../../ui";
import { SidebarThreadUndoNotice, type SidebarUndoNotice } from "./SidebarThreadUndoNotice";
import "./SidebarChrome.css";

export interface SidebarChromeHeaderProps {
  brandLabel?: string | undefined;
  homeLabel?: string | undefined;
  onHome?: (() => void) | undefined;
  toggleLabel: string;
  onToggleSidebar?: (() => void) | undefined;
  leading?: ReactNode;
}

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  brandLabel = "Inkstone",
  homeLabel,
  onHome,
  toggleLabel,
  onToggleSidebar,
  leading,
}: SidebarChromeHeaderProps) {
  return (
    <div
      className="t3-sidebar-chrome"
      data-slot="sidebar-chrome-header"
      data-testid="t3-sidebar-chrome-header"
    >
      {leading ? <div className="t3-sidebar-chrome__leading">{leading}</div> : null}
      {onToggleSidebar ? (
        <div className="t3-sidebar-chrome__toggle">
          <IconButton data-t3-btn variant="ghost" size="md" onPress={onToggleSidebar} aria-label={toggleLabel}>
            <PanelLeft />
          </IconButton>
        </div>
      ) : null}
      <div className="t3-sidebar-chrome__title">
        <SidebarBrand brandLabel={brandLabel} homeLabel={homeLabel} onHome={onHome} flush={leading != null} />
      </div>
    </div>
  );
});

function SidebarBrand({
  brandLabel,
  homeLabel,
  onHome,
  flush,
}: {
  flush: boolean;
  brandLabel: string;
  homeLabel: string | undefined;
  onHome: (() => void) | undefined;
}) {
  const className = cx(
    "t3-sidebar-brand",
    !flush && "t3-sidebar-brand--inset",
    onHome !== undefined && "t3-sidebar-brand--link",
  );
  const content = (
    <span className="t3-sidebar-brand__label">
      <BrandMark size={14} decorative className="t3-sidebar-brand__mark" />
      <span className="t3-sidebar-brand__text">{brandLabel}</span>
    </span>
  );
  if (!onHome) {
    return (
      <span className={className} data-testid="t3-sidebar-brand">
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={homeLabel ?? brandLabel}
      onClick={onHome}
      className={className}
      data-testid="t3-sidebar-brand"
    >
      {content}
    </button>
  );
}

export type SidebarConnectionState = "ready" | "starting" | "down" | "exited" | "error";

export interface SidebarConnectionView {
  state: SidebarConnectionState;
  label: string;
  detail?: string | null | undefined;
}

export interface SidebarUtilityEntry {
  key: string;
  label: string;
  icon: ReactNode;
  active?: boolean | undefined;
  attention?: "running" | "awaiting" | null | undefined;
  onSelect: () => void;
}

export interface SidebarChromeFooterProps {
  showUndoNotice?: boolean;
  undo?: SidebarUndoNotice | null | undefined;
  userName: string;
  connection?: SidebarConnectionView | undefined;
  utilities?: readonly SidebarUtilityEntry[] | undefined;
  retrying?: boolean | undefined;
  retryLabel?: string | undefined;
  onRetryConnection?: (() => void) | undefined;
  connectionSettingsLabel?: string | undefined;
  onConnectionSettings?: (() => void) | undefined;
}

const CONNECTION_DOT: Record<SidebarConnectionState, StatusDotKind> = {
  ready: "ok",
  starting: "awaiting",
  down: "fail",
  exited: "fail",
  error: "fail",
};

export const SidebarChromeFooter = memo(function SidebarChromeFooter({
  showUndoNotice = false,
  undo,
  userName,
  connection,
  utilities = [],
  retrying = false,
  retryLabel,
  onRetryConnection,
  connectionSettingsLabel,
  onConnectionSettings,
}: SidebarChromeFooterProps) {
  const t = useT();
  const connectionBroken =
    connection !== undefined && (connection.state === "exited" || connection.state === "error");
  const listRef = useRef<HTMLUListElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [fit, setFit] = useState(utilities.length);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const measure = (): void => {
      const gap = 4;
      const slot = 32 + gap;
      let used = 0;
      for (const item of list.querySelectorAll<HTMLElement>(":scope > [data-footer-fixed]")) used += item.offsetWidth + gap;
      const room = list.clientWidth - used;
      const total = utilities.length;
      setFit(room >= total * slot ? total : Math.max(0, Math.floor((room - slot) / slot)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [utilities.length, userName, connectionBroken]);
  const shown = utilities.slice(0, fit);
  const hidden = utilities.slice(fit);
  const hiddenAttention = hidden.find((entry) => entry.attention)?.attention ?? null;

  return (
    <div
      className="t3-sidebar-footer"
      data-slot="sidebar-footer"
      data-testid="t3-sidebar-chrome-footer"
    >
      {showUndoNotice ? <SidebarThreadUndoNotice notice={undo ?? null} /> : null}
      <ul
        data-slot="sidebar-menu"
        ref={listRef}
        className="t3-sidebar-footer__menu"
      >
        <li className="t3-sidebar-footer__item t3-sidebar-footer__item--user" data-footer-fixed>
          <span
            title={userName}
            className="t3-sidebar-user"
            data-testid="t3-sidebar-user"
          >
            <span className="t3-sidebar-user__avatar">
              <Avatar name={userName} />
            </span>
            <span className="t3-sidebar-user__name">{userName}</span>
          </span>
        </li>
        <li aria-hidden className="t3-sidebar-footer__spacer" />
        {connectionBroken && onRetryConnection ? (
          <li className="t3-sidebar-footer__item" data-footer-fixed>
            <Button data-t3-btn variant="ghost" size="sm" isDisabled={retrying} onPress={onRetryConnection} data-testid="t3-sidebar-conn-retry">
              {retryLabel ?? t("conn.retry")}
            </Button>
          </li>
        ) : null}
        {connectionBroken && onConnectionSettings ? (
          <li className="t3-sidebar-footer__item" data-footer-fixed>
            <IconButton
              data-t3-btn
              variant="ghost"
              size="md"
              aria-label={connectionSettingsLabel ?? t("set.devices")}
              tooltip={connectionSettingsLabel ?? t("set.devices")}
              onPress={() => onConnectionSettings()}
              className="t3-sidebar-icon-btn"
              data-testid="t3-sidebar-conn-settings"
            >
              <Unplug className="t3-status--failed" />
            </IconButton>
          </li>
        ) : null}
        {connection && connection.state !== "ready" ? (
          <li className="t3-sidebar-footer__item" data-footer-fixed>
            <TooltipTrigger>
              <Focusable>
                <button
                  type="button"
                  role="status"
                  aria-label={connection.label}
                  title={connection.detail ? `${connection.label}\n${connection.detail}` : connection.label}
                  className="t3-sidebar-connection"
                  data-testid="t3-sidebar-conn"
                >
                  <StatusDot kind={CONNECTION_DOT[connection.state]} />
                </button>
              </Focusable>
              <Tooltip><TooltipHint label={connection.label} /></Tooltip>
            </TooltipTrigger>
          </li>
        ) : null}
        {shown.map((entry) => (
          <li key={entry.key} className="t3-sidebar-footer__item">
            <IconButton
              data-t3-btn
              variant="ghost"
              size="md"
              aria-label={entry.label}
              tooltip={entry.label}
              aria-current={entry.active ? "page" : undefined}
              data-active={entry.active ? "true" : undefined}
              onPress={() => entry.onSelect()}
              className="t3-sidebar-icon-btn"
              data-testid={`t3-sidebar-utility-${entry.key}`}
            >
              {entry.icon}
              {entry.attention ? (
                <StatusDot kind={entry.attention === "awaiting" ? "awaiting" : "running"} className="t3-sidebar-icon-btn__dot" />
              ) : null}
            </IconButton>
          </li>
        ))}
        {hidden.length > 0 ? (
          <li className="t3-sidebar-footer__item">
            <IconButton
              ref={moreRef}
              data-t3-btn
              variant="ghost"
              size="md"
              aria-label={t("sidebar.t3.moreUtilities")}
              title={t("sidebar.t3.moreUtilities")}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              data-active={moreOpen ? "true" : undefined}
              onPress={() => setMoreOpen(true)}
              className="t3-sidebar-icon-btn"
              data-testid="t3-sidebar-utility-more"
            >
              <MoreHorizontal />
              {hiddenAttention ? (
                <StatusDot kind={hiddenAttention === "awaiting" ? "awaiting" : "running"} className="t3-sidebar-icon-btn__dot" />
              ) : null}
            </IconButton>
            <Popover triggerRef={moreRef} isOpen={moreOpen} onOpenChange={setMoreOpen} placement="top end" offset={6}>
              <Menu
                aria-label={t("sidebar.t3.moreUtilities")}
                autoFocus="first"
                onClose={() => setMoreOpen(false)}
                onAction={(key) => {
                  setMoreOpen(false);
                  hidden.find((entry) => entry.key === key)?.onSelect();
                }}
                data-testid="t3-sidebar-utility-menu"
              >
                {hidden.map((entry) => (
                  <MenuItem key={entry.key} id={entry.key} textValue={entry.label} icon={entry.icon}>
                    {entry.label}
                  </MenuItem>
                ))}
              </Menu>
            </Popover>
          </li>
        ) : null}
      </ul>
    </div>
  );
});
