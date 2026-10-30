import {
  memo,
  useEffect,
  useRef,
  useState,
  type DOMAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  AlarmClock,
  AlarmClockOff,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDotDashed,
  CircleDashed,
  Clock,
  MessageCircleQuestion,
  Pin,
  PinOff,
  ShieldQuestion,
  SquarePen,
  Undo2,
  X,
} from "lucide-react";

import { useT, type MessageKey, type TFunc } from "../../../i18n";
import { cn } from "../../lib/utils";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import {
  ThreadDiffCount,
  ThreadWorktreeIndicator,
  type ThreadDiff,
} from "../ThreadStatusIndicators";

export type SidebarRowVariant = "card" | "slim" | "folder" | "folder-multiline";

export type SidebarRowStatus = "working" | "waiting" | "approval" | "input" | "failed" | "done";

export type SidebarRowDropVerb = "pin" | "unpin" | "archive" | "unarchive" | "wake";

export interface SnoozePresetView {
  id: string;
  label: string;
  until: number;
}

export interface SidebarThreadRowView {
  threadKey: string;
  sessionPath?: string | null;
  title: string;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  branch: string | null;
  worktreePath: string | null;
  status: SidebarRowStatus | null;
  workingStartedAt: number | null;
  timeLabel: string | null;
  pinned: boolean;
  recede: boolean;
  isUnread: boolean;
  isWoke: boolean;
  snoozeWakeLabel: string | null;
  hasUnsentDraft: boolean;
  jumpLabel: string | null;
  modelLabel: string | null;
  diff: ThreadDiff | null;
}

export interface SidebarSortableBag {
  setNodeRef?: ((node: HTMLElement | null) => void) | undefined;
  listeners?: Record<string, unknown> | undefined;
  transform?: { x: number; y: number } | null | undefined;
  transition?: string | null | undefined;
  isDragging?: boolean | undefined;
}

export interface SidebarThreadRowProps {
  view: SidebarThreadRowView;
  variant?: SidebarRowVariant;
  isActive?: boolean;
  navigationParent?: string;
  dropVerb?: SidebarRowDropVerb | null;
  isDragging?: boolean;
  isFileDragOver?: boolean;
  renaming?: boolean;
  renameValue?: string;
  snoozePresets?: readonly SnoozePresetView[];
  sortable?: SidebarSortableBag | undefined;
  fileDropHandlers?: DOMAttributes<HTMLElement> | undefined;
  onOpen?: (event: ReactMouseEvent) => void;
  onActivate?: () => void;
  onContextMenu?: (position: { x: number; y: number }) => void;
  onRenameStart?: () => void;
  onRenameChange?: (value: string) => void;
  onRenameCommit?: () => void;
  onRenameCancel?: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onDelete?: () => void;
  onSnooze?: (until: number) => void;
  onUnsnooze?: () => void;
  onUnpin?: () => void;
  onDiscardDraft?: () => void;
  onAcknowledgeWoke?: () => void;
}

const TOP_STATUS_ICONS = {
  working: CircleDashed,
  waiting: CircleDotDashed,
  input: MessageCircleQuestion,
  approval: ShieldQuestion,
  failed: CircleAlert,
  done: CircleCheck,
  woke: AlarmClock,
} as const;

type TopStatusIconName = keyof typeof TOP_STATUS_ICONS;

interface TopStatus {
  labelKey: MessageKey;
  icon: TopStatusIconName;
  className: string;
}

const TOP_STATUS: Record<SidebarRowStatus, TopStatus> = {
  working: {
    labelKey: "sidebar.t3.status.working",
    icon: "working",
    className: "text-info-foreground",
  },
  waiting: {
    labelKey: "sidebar.t3.status.waiting",
    icon: "waiting",
    className: "text-muted-foreground",
  },
  approval: {
    labelKey: "sidebar.t3.status.approval",
    icon: "approval",
    className: "text-warning-foreground",
  },
  input: {
    labelKey: "sidebar.t3.status.input",
    icon: "input",
    className: "text-indigo-600 dark:text-indigo-300",
  },
  failed: {
    labelKey: "sidebar.t3.status.failed",
    icon: "failed",
    className: "text-error-foreground",
  },
  done: {
    labelKey: "sidebar.t3.status.done",
    icon: "done",
    className: "text-success-foreground",
  },
};

const DROP_VERB_PRESENTATION: Record<
  SidebarRowDropVerb,
  { labelKey: MessageKey; Icon: typeof Pin }
> = {
  pin: { labelKey: "sidebar.t3.pin", Icon: Pin },
  unpin: { labelKey: "sidebar.t3.unpin", Icon: PinOff },
  archive: { labelKey: "sidebar.t3.archive", Icon: Check },
  unarchive: { labelKey: "sidebar.t3.unarchive", Icon: Undo2 },
  wake: { labelKey: "sidebar.t3.wake", Icon: AlarmClockOff },
};

function TopStatusIcon({ icon, className }: { icon: TopStatusIconName; className: string }) {
  const Icon = TOP_STATUS_ICONS[icon];
  return <Icon aria-hidden className={cn("shrink-0", className)} />;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function useNowSecond(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function WorkingDuration({ startedAt }: { startedAt: number | null }) {
  const now = useNowSecond();
  if (startedAt === null || Number.isNaN(startedAt)) return null;
  return <span className="tabular-nums">{formatElapsed(now - startedAt)}</span>;
}

function JumpHintBadge({ label }: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
    >
      {label}
    </span>
  );
}

function DragDestination({ verb, t }: { verb: SidebarRowDropVerb; t: TFunc }) {
  const { labelKey, Icon } = DROP_VERB_PRESENTATION[verb];
  return (
    <span
      role="status"
      className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
    >
      <Icon aria-hidden className="size-3" />
      {t(labelKey)}
    </span>
  );
}

function RenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const settledRef = useRef(false);
  return (
    <input
      autoFocus
      value={value}
      dir="auto"
      aria-label={t("sidebar.t3.renameLabel")}
      onChange={(event) => onChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
          event.preventDefault();
          settledRef.current = true;
          onCommit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          settledRef.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!settledRef.current) onCommit();
      }}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  );
}

function rowAccessibilityLabel(view: SidebarThreadRowView, statusLabel: string | null): string {
  return [view.title, view.projectDisplayName, statusLabel].filter((part) => !!part).join(" · ");
}

export const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    view,
    variant = "card",
    isActive = false,
    navigationParent,
    dropVerb = null,
    isDragging = false,
    isFileDragOver = false,
    renaming = false,
    renameValue = "",
    snoozePresets = [],
    sortable,
    fileDropHandlers,
    onOpen,
    onActivate,
    onContextMenu,
    onRenameStart,
    onRenameChange,
    onRenameCommit,
    onRenameCancel,
    onArchive,
    onUnarchive,
    onDelete,
    onSnooze,
    onUnsnooze,
    onUnpin,
    onDiscardDraft,
    onAcknowledgeWoke,
  } = props;
  const t = useT();
  const status = view.status;
  const topStatus = status === null ? null : TOP_STATUS[status];
  const statusLabel = view.isWoke
    ? t("sidebar.t3.status.woke")
    : topStatus
      ? t(topStatus.labelKey)
      : null;
  const inFolder = variant === "folder" || variant === "folder-multiline";
  const metaLineEmpty =
    !view.branch && view.diff === null && view.worktreePath === null && view.modelLabel === null;

  const sortableProps = sortable
    ? {
        ref: sortable.setNodeRef,
        style: {
          transform: sortable.transform
            ? `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0)`
            : undefined,
          transition: sortable.transition ?? undefined,
        },
        ...(sortable.listeners as DOMAttributes<HTMLElement> | undefined),
      }
    : {};

  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    isActive
      ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
      : view.hasUnsentDraft
        ? "bg-warning/4 text-sidebar-foreground hover:bg-warning/8"
        : view.recede
          ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    view.recede &&
      status === "working" &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
    isFileDragOver && "ring-1 ring-inset ring-primary/70",
    isFileDragOver && !isActive && "bg-sidebar-row-hover",
    isDragging &&
      "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "F2" && !renaming && onRenameStart) {
      event.preventDefault();
      onRenameStart();
      return;
    }
    if (event.key === "Delete" && onDelete) {
      event.preventDefault();
      onDelete();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onActivate?.();
  };

  const title = renaming ? (
    <RenameInput
      value={renameValue}
      onChange={(value) => onRenameChange?.(value)}
      onCommit={() => onRenameCommit?.()}
      onCancel={() => onRenameCancel?.()}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        "min-w-0 flex-1 truncate text-start text-sm transition-opacity motion-reduce:transition-none",
        view.recede ? "font-normal" : "font-medium",
        variant !== "slim"
          ? cn(
              view.recede
                ? "text-foreground/75 group-hover/sidebar-row:text-foreground group-focus-visible/sidebar-row:text-foreground"
                : status === "failed" && !view.isUnread && !view.isWoke
                  ? "text-foreground/95"
                  : "text-foreground",
            )
          : cn(
              "group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
              view.recede
                ? "text-secondary-label"
                : isActive || view.isWoke || status === "input"
                  ? "text-foreground"
                  : view.isUnread
                    ? "text-muted-foreground"
                    : "text-secondary-label/70",
            ),
      )}
      dir="auto"
    >
      {view.title}
    </span>
  );

  const draftIndicator = view.hasUnsentDraft ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={t("sidebar.t3.unsentDraft")}
            data-testid={`sidebar-draft-indicator-${view.threadKey}`}
            className="inline-flex shrink-0 items-center"
          />
        }
      >
        <SquarePen aria-hidden className="size-3 text-warning-foreground" />
      </TooltipTrigger>
      <TooltipPopup side="top">{t("sidebar.t3.unsentDraft")}</TooltipPopup>
    </Tooltip>
  ) : null;

  const pinIndicator = !view.pinned ? null : renaming ? (
    <Pin aria-label={t("sidebar.t3.pinned")} role="img" className="size-3 shrink-0 text-muted-foreground/65" />
  ) : (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={t("sidebar.t3.unpin")}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onUnpin?.();
            }}
            className="group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <Pin
          aria-hidden
          className="size-3 shrink-0 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
        />
        <PinOff
          aria-hidden
          className="hidden size-3 shrink-0 group-hover/unpin:block group-focus-visible/unpin:block"
        />
      </TooltipTrigger>
      <TooltipPopup>{t("sidebar.t3.unpin")}</TooltipPopup>
    </Tooltip>
  );

  const wokeButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={t("sidebar.t3.dismissWoke")}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onAcknowledgeWoke?.();
            }}
            className="inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium text-warning-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <AlarmClock aria-hidden className="size-4 shrink-0" />
        <span role="status">{t("sidebar.t3.status.woke")}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{t("sidebar.t3.dismissWoke")}</TooltipPopup>
    </Tooltip>
  );

  const snoozeMenu =
    snoozePresets.length > 0 && onSnooze ? (
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={t("sidebar.t3.snooze")}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                  />
                }
              />
            }
          >
            <Clock className="size-3" />
          </TooltipTrigger>
          <TooltipPopup>{t("sidebar.t3.snooze")}</TooltipPopup>
        </Tooltip>
        <MenuPopup side="bottom" align="end" className="min-w-40">
          {snoozePresets.map((preset) => (
            <MenuItem
              key={preset.id}
              onClick={() => onSnooze(preset.until)}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <AlarmClock className="size-3.5" />
              <MenuItemLabel>{preset.label}</MenuItemLabel>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    ) : null;

  const archiveButton = onArchive ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={t("sidebar.t3.archive")}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onArchive();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Check className="size-3.5" />
        {t("sidebar.t3.archive")}
      </TooltipTrigger>
      <TooltipPopup>{t("sidebar.t3.archive")}</TooltipPopup>
    </Tooltip>
  ) : null;

  const unarchiveButton = onUnarchive ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={t("sidebar.t3.unarchive")}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onUnarchive();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Undo2 className="mb-px size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{t("sidebar.t3.unarchive")}</TooltipPopup>
    </Tooltip>
  ) : null;

  const unsnoozeButton = onUnsnooze ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={t("sidebar.t3.wake")}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onUnsnooze();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            className={cn(
              "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
              view.isWoke && "group-any-hover/sidebar-row:static",
            )}
          />
        }
      >
        <AlarmClockOff className="mb-px size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{t("sidebar.t3.wake")}</TooltipPopup>
    </Tooltip>
  ) : null;

  const discardDraftButton =
    view.hasUnsentDraft && onDiscardDraft ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={t("sidebar.t3.discardDraft")}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDiscardDraft();
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
            />
          }
        >
          <X className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">{t("sidebar.t3.discardDraft")}</TooltipPopup>
      </Tooltip>
    ) : null;

  const clockTime =
    view.timeLabel === null ? null : <span className="text-xs">{view.timeLabel}</span>;

  const wakeTimeLabel =
    view.snoozeWakeLabel === null ? null : (
      <span className="inline-flex items-center gap-1 text-xs text-info-foreground tabular-nums">
        <AlarmClock aria-hidden className="size-3" />
        {view.snoozeWakeLabel}
      </span>
    );

  const dragDestination = dropVerb !== null ? <DragDestination verb={dropVerb} t={t} /> : null;

  const metaLine = metaLineEmpty ? null : (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
      {view.branch ? (
        <>
          <ThreadWorktreeIndicator worktreePath={view.worktreePath} branch={view.branch} />
          <span className="flex min-w-0 flex-1">
            <span className="min-w-0 truncate font-mono text-2xs">{view.branch}</span>
          </span>
        </>
      ) : (
        <span className="flex-1" />
      )}
      <ThreadDiffCount diff={view.diff} />
      {view.modelLabel ? (
        <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
          {view.modelLabel}
        </span>
      ) : null}
    </div>
  );

  const hoverCard = (
    <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
      <ThreadHoverCard title={view.title}>
        {view.projectDisplayName !== null ? (
          <div className="flex min-w-0 items-center gap-2">
            <ProjectFavicon project={view.project} className="size-3 shrink-0" />
            <div className="min-w-0 truncate text-foreground/75">{view.projectDisplayName}</div>
          </div>
        ) : null}
        {view.branch !== null ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-2xs text-foreground/75">
              {view.branch}
            </span>
          </div>
        ) : null}
        {view.modelLabel !== null ? (
          <div className="min-w-0 truncate text-foreground/75">{view.modelLabel}</div>
        ) : null}
        {statusLabel !== null ? (
          <div className={cn("min-w-0 truncate", topStatus?.className)}>{statusLabel}</div>
        ) : null}
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );

  return (
    <li
      data-thread-item={view.threadKey}
      {...sortableProps}
      {...fileDropHandlers}
      className={cn(
        "list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]",
        variant === "card" && "py-0.5 [contain-intrinsic-size:auto_78px]",
        variant === "folder-multiline" && "[contain-intrinsic-size:auto_54px]",
        (variant === "card" || variant === "folder-multiline") &&
          metaLineEmpty &&
          "[contain-intrinsic-size:auto_58px]",
        isDragging && "relative z-20",
      )}
    >
      <Tooltip disabled={isDragging}>
        <TooltipTrigger
          render={
            <div
              ref={sortable?.setNodeRef}
              role="treeitem"
              tabIndex={-1}
              data-sidebar-row={view.threadKey}
              data-session-path={view.sessionPath ?? undefined}
              data-sidebar-parent={navigationParent}
              aria-label={rowAccessibilityLabel(view, statusLabel)}
              aria-current={isActive ? "true" : undefined}
              data-testid={
                variant === "card"
                  ? "sidebar-row-card"
                  : variant === "slim"
                    ? "sidebar-row-slim"
                    : "sidebar-row-folder"
              }
              className={cn(
                rowSurfaceClassName,
                variant === "card"
                  ? undefined
                  : variant === "folder-multiline"
                    ? "flex flex-col justify-center px-2.5 py-1.5"
                    : "flex h-9 items-center gap-2.5 px-2.5",
                inFolder && "ps-9",
              )}
              onClick={(event) => onOpen?.(event)}
              onDoubleClick={(event) => {
                if ((event.target as HTMLElement).closest("button, a, input")) return;
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onRenameStart?.();
              }}
              onKeyDown={handleKeyDown}
              onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu?.({ x: event.clientX, y: event.clientY });
              }}
            />
          }
        >
          {renaming ? null : <span className="sr-only">{view.title}</span>}
          {variant === "card" ? (
            <div
              className={cn(
                "relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
                metaLineEmpty && "h-auto",
              )}
            >
              <div className="flex h-5 min-w-0 items-center gap-1.5">
                {draftIndicator}
                <ProjectFavicon project={view.project} className="size-4 shrink-0" />
                {pinIndicator}
                {view.projectDisplayName !== null ? (
                  <span className="min-w-0 flex-1 truncate font-normal text-secondary-label text-xs">
                    {view.projectDisplayName}
                  </span>
                ) : (
                  <span className="flex-1" />
                )}
                {isDragging ? (
                  dragDestination
                ) : (
                  <span className="group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
                    <span
                      className={cn(
                        view.isWoke
                          ? "pointer-events-auto"
                          : "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:absolute group-any-hover/sidebar-row:right-0 group-any-hover/sidebar-row:opacity-0",
                        "flex items-center self-center justify-self-end tabular-nums text-secondary-label",
                      )}
                    >
                      {view.isWoke ? (
                        wokeButton
                      ) : topStatus !== null ? (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 font-medium",
                            topStatus.className,
                          )}
                        >
                          <TopStatusIcon icon={topStatus.icon} className="size-4" />
                          {t(topStatus.labelKey)}
                          {status === "working" ? (
                            <span aria-hidden>
                              <WorkingDuration startedAt={view.workingStartedAt} />
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        clockTime
                      )}
                    </span>
                    {onArchive || onUnarchive || snoozeMenu || discardDraftButton ? (
                      <span className="pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100">
                        {discardDraftButton}
                        {snoozeMenu}
                        {onUnarchive ? unarchiveButton : archiveButton}
                      </span>
                    ) : null}
                  </span>
                )}
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-1.5">{title}</div>
              {metaLine}
            </div>
          ) : (
            <>
              <div
                className={
                  variant === "folder-multiline"
                    ? "flex h-6 min-w-0 items-center gap-2.5"
                    : "contents"
                }
              >
                {inFolder ? null : (
                  <span
                    className={cn(
                      "flex shrink-0 items-center transition-opacity",
                      !isActive &&
                        "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
                    )}
                  >
                    <ProjectFavicon project={view.project} className="size-4" />
                  </span>
                )}
                {draftIndicator}
                {title}
                {pinIndicator}
                {isDragging ? (
                  dragDestination
                ) : (
                  <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
                    <span
                      className={cn(
                        "inline-flex justify-end tabular-nums text-secondary-label transition-opacity",
                        !view.isWoke && "group-any-hover/sidebar-row:opacity-0",
                      )}
                    >
                      {wakeTimeLabel ?? (view.isWoke ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-warning-foreground">
                          <TopStatusIcon icon="woke" className="size-3" />
                          {t("sidebar.t3.status.woke")}
                        </span>
                      ) : inFolder && topStatus !== null ? (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 text-xs font-medium",
                            topStatus.className,
                          )}
                        >
                          <TopStatusIcon icon={topStatus.icon} className="size-3" />
                          {t(topStatus.labelKey)}
                        </span>
                      ) : (
                        clockTime
                      ))}
                    </span>
                    {onUnarchive ? unsnoozeButton : null}
                    {onArchive || onUnarchive ? (
                      <span className="pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100">
                        {onUnarchive ? unarchiveButton : archiveButton}
                      </span>
                    ) : null}
                  </span>
                )}
              </div>
              {variant === "folder-multiline" ? metaLine : null}
            </>
          )}
          {view.jumpLabel !== null ? <JumpHintBadge label={view.jumpLabel} /> : null}
        </TooltipTrigger>
        {hoverCard}
      </Tooltip>
    </li>
  );
});
