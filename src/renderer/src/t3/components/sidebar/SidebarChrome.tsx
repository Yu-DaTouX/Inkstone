import { CircleAlert, CircleDot, LoaderCircle, MoreHorizontal, PanelLeft, Unplug } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useT } from "../../../i18n";
import { Avatar, Menu, MenuItem, Popover } from "../../../ui";
import { cn } from "../../lib/utils";
import { BrandMark } from "../../../features/sidebar/BrandMark";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarThreadUndoNotice, type SidebarUndoNotice } from "./SidebarThreadUndoNotice";
import { SIDEBAR_MENU_BUTTON, SIDEBAR_MENU_ICON_BUTTON } from "./SidebarThreadHeader";

export interface SidebarChromeHeaderProps {
  brandLabel?: string | undefined;
  homeLabel?: string | undefined;
  onHome?: (() => void) | undefined;
  toggleLabel: string;
  onToggleSidebar?: (() => void) | undefined;
  status?: ReactNode;
  leading?: ReactNode;
}

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  brandLabel = "Inkstone",
  homeLabel,
  onHome,
  toggleLabel,
  onToggleSidebar,
  status,
  leading,
}: SidebarChromeHeaderProps) {
  return (
    <div
      className="relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3"
      data-testid="t3-sidebar-chrome-header"
    >
      {leading ? <div className="relative z-10 ml-3 flex shrink-0 items-center">{leading}</div> : null}
      {onToggleSidebar ? (
        <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={toggleLabel}
            className="relative top-auto translate-y-0"
            onClick={onToggleSidebar}
          >
            <PanelLeft />
          </Button>
        </div>
      ) : null}
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <SidebarBrand brandLabel={brandLabel} homeLabel={homeLabel} onHome={onHome} flush={leading != null} />
        {status}
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
  const className = cn(
    "relative z-10 hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md text-foreground outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex",
    !flush && "ml-[var(--workspace-titlebar-content-left,var(--sidebar-content-inset))]",
    onHome !== undefined && "cursor-pointer",
  );
  const content = (
    <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
      <BrandMark size={14} decorative className="shrink-0 self-center" />
      <span className="truncate text-muted-foreground">{brandLabel}</span>
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

export type SidebarAttentionKind = "running" | "awaiting" | "unread";

export interface SidebarAttentionItem {
  kind: SidebarAttentionKind;
  count: number;
  label: string;
}

const ATTENTION_GLYPH = {
  running: { Icon: LoaderCircle, tone: "text-info-foreground animate-spin" },
  awaiting: { Icon: CircleAlert, tone: "text-warning-foreground" },
  unread: { Icon: CircleDot, tone: "text-success-foreground" },
} as const;

export function SidebarAttentionSummary({
  ariaLabel,
  items,
  onJump,
}: {
  ariaLabel: string;
  items: readonly SidebarAttentionItem[];
  onJump: (kind: SidebarAttentionKind) => void;
}) {
  if (items.length === 0) return null;
  return (
    <span
      role="group"
      aria-label={ariaLabel}
      className="flex h-7 shrink-0 items-center gap-0.5"
      data-testid="t3-sidebar-attention"
    >
      {items.map((item) => {
        const { Icon, tone } = ATTENTION_GLYPH[item.kind];
        return (
          <Tooltip key={item.kind}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={item.label}
                  onClick={() => onJump(item.kind)}
                  className="flex h-5 cursor-pointer items-center gap-1 rounded-sm px-1 text-2xs font-medium text-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset"
                  data-kind={item.kind}
                />
              }
            >
              <Icon className={cn("size-3.5 shrink-0", tone)} />
              <span className="tabular-nums">{item.count}</span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">{item.label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </span>
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

const CONNECTION_DOT: Record<SidebarConnectionState, string> = {
  ready: "bg-success",
  starting: "bg-warning",
  down: "bg-error",
  exited: "bg-error",
  error: "bg-error",
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
      className="flex flex-col gap-2 px-[var(--sidebar-content-inset)] py-1"
      data-slot="sidebar-footer"
      data-testid="t3-sidebar-chrome-footer"
    >
      {showUndoNotice ? <SidebarThreadUndoNotice notice={undo ?? null} /> : null}
      <ul
        data-slot="sidebar-menu"
        ref={listRef}
        className="flex w-full min-w-0 flex-row flex-nowrap items-center gap-1"
      >
        <li className="min-w-0 max-w-30 shrink-0" data-footer-fixed>
          <span
            title={userName}
            className="flex h-8 min-w-0 items-center gap-2 px-[var(--sidebar-row-content-inset)] text-xs font-medium text-sidebar-muted-foreground/80"
            data-testid="t3-sidebar-user"
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              <Avatar name={userName} />
            </span>
            <span className="truncate">{userName}</span>
          </span>
        </li>
        <li aria-hidden className="min-w-0 flex-1" />
        {connectionBroken && onRetryConnection ? (
          <li className="shrink-0" data-footer-fixed>
            <Button
              size="micro"
              variant="ghost-muted"
              disabled={retrying}
              onClick={onRetryConnection}
              data-testid="t3-sidebar-conn-retry"
            >
              {retryLabel ?? t("conn.retry")}
            </Button>
          </li>
        ) : null}
        {connectionBroken && onConnectionSettings ? (
          <li className="shrink-0" data-footer-fixed>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={connectionSettingsLabel ?? t("set.devices")}
                    onClick={onConnectionSettings}
                    className={cn(SIDEBAR_MENU_BUTTON, SIDEBAR_MENU_ICON_BUTTON, "relative")}
                    data-testid="t3-sidebar-conn-settings"
                  />
                }
              >
                <Unplug className="text-error-foreground" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {connectionSettingsLabel ?? t("set.devices")}
              </TooltipPopup>
            </Tooltip>
          </li>
        ) : null}
        {connection ? (
          <li className="shrink-0" data-footer-fixed>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    role="status"
                    aria-label={connection.label}
                    title={connection.detail ? `${connection.label}\n${connection.detail}` : connection.label}
                    className="flex size-4 items-center justify-center outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
                    data-testid="t3-sidebar-conn"
                  />
                }
              >
                <span
                  className={cn("size-1.5 rounded-full", CONNECTION_DOT[connection.state])}
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{connection.label}</TooltipPopup>
            </Tooltip>
          </li>
        ) : null}
        {shown.map((entry) => (
          <li key={entry.key} className="shrink-0">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={entry.label}
                    aria-current={entry.active ? "page" : undefined}
                    data-active={entry.active ? "true" : undefined}
                    onClick={entry.onSelect}
                    className={cn(SIDEBAR_MENU_BUTTON, SIDEBAR_MENU_ICON_BUTTON, "relative")}
                    data-testid={`t3-sidebar-utility-${entry.key}`}
                  />
                }
              >
                {entry.icon}
                {entry.attention ? (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-1 right-1 size-1.5 rounded-full",
                      entry.attention === "awaiting" ? "bg-warning" : "bg-info",
                    )}
                  />
                ) : null}
              </TooltipTrigger>
              <TooltipPopup side="top">{entry.label}</TooltipPopup>
            </Tooltip>
          </li>
        ))}
        {hidden.length > 0 ? (
          <li className="shrink-0">
            <button
              ref={moreRef}
              type="button"
              aria-label={t("sidebar.t3.moreUtilities")}
              title={t("sidebar.t3.moreUtilities")}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              data-active={moreOpen ? "true" : undefined}
              onClick={() => setMoreOpen(true)}
              className={cn(SIDEBAR_MENU_BUTTON, SIDEBAR_MENU_ICON_BUTTON, "relative")}
              data-testid="t3-sidebar-utility-more"
            >
              <MoreHorizontal />
              {hiddenAttention ? (
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-1 right-1 size-1.5 rounded-full",
                    hiddenAttention === "awaiting" ? "bg-warning" : "bg-info",
                  )}
                />
              ) : null}
            </button>
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
