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
} from "../../../ui/icons";

import { useT, type MessageKey, type TFunc } from "../../../i18n";
import { cx } from "../../../ui/cx";
import { BareButton, Badge, Focusable, Kbd, Menu, MenuItem, MenuTrigger, Popover, TooltipTrigger, Tooltip, TooltipHint } from "../../../ui";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import {
  ThreadDiffCount,
  ThreadWorktreeIndicator,
  type ThreadDiff,
} from "../ThreadStatusIndicators";
import "./SidebarThreadRow.css";

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
  onContextMenu?: (position: { x: number; y: number } | null) => void;
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
    className: "t3-status--working",
  },
  waiting: {
    labelKey: "sidebar.t3.status.waiting",
    icon: "waiting",
    className: "t3-status--waiting",
  },
  approval: {
    labelKey: "sidebar.t3.status.approval",
    icon: "approval",
    className: "t3-status--approval",
  },
  input: {
    labelKey: "sidebar.t3.status.input",
    icon: "input",
    className: "t3-status--approval",
  },
  failed: {
    labelKey: "sidebar.t3.status.failed",
    icon: "failed",
    className: "t3-status--failed",
  },
  done: {
    labelKey: "sidebar.t3.status.done",
    icon: "done",
    className: "t3-status--done",
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
  return (
    <Icon
      aria-hidden
      data-status-icon={icon}
      className={cx("t3-icon", icon === "working" && "t3-thread-row__spin", className)}
    />
  );
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
  return <span className="t3-thread-row__elapsed">{formatElapsed(now - startedAt)}</span>;
}

function JumpHintBadge({ label }: { label: string }) {
  return (
    <Kbd aria-hidden className="t3-thread-row__jump">
      {label}
    </Kbd>
  );
}

function DragDestination({ verb, t }: { verb: SidebarRowDropVerb; t: TFunc }) {
  const { labelKey, Icon } = DROP_VERB_PRESENTATION[verb];
  return (
    <Badge tone="accent" role="status" className="t3-thread-row__drop-hint">
      <Icon aria-hidden className="t3-icon--xs" />
      {t(labelKey)}
    </Badge>
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
      className="ui-inline-rename t3-thread-row__rename"
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
    !view.branch && view.diff === null && view.worktreePath === null;

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

  const rowSurfaceClassName = cx(
    "t3-g-sidebar-row t3-thread-row__surface",
    isActive
      ? "t3-thread-row__surface--active"
      : view.hasUnsentDraft
        ? "t3-thread-row__surface--draft"
        : view.recede
          ? "t3-thread-row__surface--receded"
          : "t3-thread-row__surface--idle",
    isFileDragOver && "t3-thread-row__surface--drop-target",
    isDragging &&
      "t3-thread-row__surface--lifted",
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
      className={cx(
        "t3-thread-row__title",
        view.recede && "t3-thread-row__title--receded",
        variant === "slim" &&
          !(isActive || view.isWoke || status === "input" || view.isUnread) &&
          "t3-thread-row__title--muted",
      )}
      dir="auto"
    >
      {view.title}
    </span>
  );

  const draftIndicator = view.hasUnsentDraft ? (
    <TooltipTrigger>
      <Focusable excludeFromTabOrder><span role="img" aria-label={t("sidebar.t3.unsentDraft")} data-testid={`sidebar-draft-indicator-${view.threadKey}`} className="t3-thread-row__draft-mark">
        <SquarePen aria-hidden className="t3-icon--xs" />
      </span></Focusable>
      <Tooltip><TooltipHint label={t("sidebar.t3.unsentDraft")} /></Tooltip>
    </TooltipTrigger>
  ) : null;

  const pinIndicator = !view.pinned ? null : renaming ? (
    <Pin aria-label={t("sidebar.t3.pinned")} role="img" className="t3-icon--xs t3-thread-row__pinned" />
  ) : (
    <TooltipTrigger>
      <Focusable><button type="button" aria-label={t("sidebar.t3.unpin")} onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onUnpin?.();
            }} className="t3-g-unpin t3-thread-row__unpin">
        <Pin
          aria-hidden
          className="t3-icon--xs t3-thread-row__pin-icon"
        />
        <PinOff
          aria-hidden
          className="t3-icon--xs t3-thread-row__unpin-icon"
        />
      </button></Focusable>
      <Tooltip><TooltipHint label={t("sidebar.t3.unpin")} /></Tooltip>
    </TooltipTrigger>
  );

  const wokeButton = (
    <TooltipTrigger>
      <Focusable><button type="button" aria-label={t("sidebar.t3.dismissWoke")} onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onAcknowledgeWoke?.();
            }} className="t3-thread-row__woke">
        <AlarmClock aria-hidden className="t3-icon--md" />
        <span role="status">{t("sidebar.t3.status.woke")}</span>
      </button></Focusable>
      <Tooltip><TooltipHint label={t("sidebar.t3.dismissWoke")} /></Tooltip>
    </TooltipTrigger>
  );

  const snoozeMenu =
    snoozePresets.length > 0 && onSnooze ? (
      <MenuTrigger>
        <TooltipTrigger>
          <BareButton
            aria-label={t("sidebar.t3.snooze")}
            onDoubleClick={(event) => event.stopPropagation()}
            className="t3-thread-row__action"
          >
            <Clock className="t3-icon--xs" />
          </BareButton>
          <Tooltip><TooltipHint label={t("sidebar.t3.snooze")} /></Tooltip>
        </TooltipTrigger>
        <Popover placement="bottom end" className="t3-thread-row__snooze-menu">
          <Menu
            aria-label={t("sidebar.t3.snooze")}
            autoFocus="first"
            onAction={(key) => {
              const preset = snoozePresets.find((entry) => entry.id === key);
              if (preset) onSnooze(preset.until);
            }}
          >
            {snoozePresets.map((preset) => (
              <MenuItem
                key={preset.id}
                id={preset.id}
                textValue={preset.label}
                icon={<AlarmClock className="t3-icon--sm" />}
              >
                {preset.label}
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>
    ) : null;

  const archiveButton = onArchive ? (
    <TooltipTrigger>
      <Focusable><button type="button" aria-label={t("sidebar.t3.archive")} onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onArchive();
            }} onPointerDown={(event) => event.stopPropagation()} className="t3-thread-row__action t3-thread-row__action--flush">
        <Check aria-hidden className="t3-icon--sm" />
      </button></Focusable>
      <Tooltip><TooltipHint label={t("sidebar.t3.archive")} /></Tooltip>
    </TooltipTrigger>
  ) : null;

  const unarchiveButton = onUnarchive ? (
    <TooltipTrigger>
      <Focusable><button type="button" aria-label={t("sidebar.t3.unarchive")} onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onUnarchive();
            }} onPointerDown={(event) => event.stopPropagation()} className="t3-thread-row__action t3-thread-row__action--flush">
        <Undo2 className="t3-icon--sm" />
      </button></Focusable>
      <Tooltip><TooltipHint label={t("sidebar.t3.unarchive")} /></Tooltip>
    </TooltipTrigger>
  ) : null;

  const unsnoozeButton = onUnsnooze ? (
    <TooltipTrigger>
      <Focusable><button type="button" aria-label={t("sidebar.t3.wake")} onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onUnsnooze();
            }} onPointerDown={(event) => event.stopPropagation()} className="t3-thread-row__action t3-thread-row__action--flush t3-thread-row__action--reveal">
        <AlarmClockOff className="t3-icon--xs" />
      </button></Focusable>
      <Tooltip><TooltipHint label={t("sidebar.t3.wake")} /></Tooltip>
    </TooltipTrigger>
  ) : null;

  const discardDraftButton =
    view.hasUnsentDraft && onDiscardDraft ? (
      <TooltipTrigger>
        <Focusable><button type="button" aria-label={t("sidebar.t3.discardDraft")} onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDiscardDraft();
              }} onPointerDown={(event) => event.stopPropagation()} className="t3-thread-row__action">
          <X className="t3-icon--sm" />
        </button></Focusable>
        <Tooltip><TooltipHint label={t("sidebar.t3.discardDraft")} /></Tooltip>
      </TooltipTrigger>
    ) : null;

  const clockTime =
    view.timeLabel === null ? null : <span className="t3-thread-row__time">{view.timeLabel}</span>;

  const wakeTimeLabel =
    view.snoozeWakeLabel === null ? null : (
      <span className="t3-thread-row__wake">
        <AlarmClock aria-hidden className="t3-icon--xs" />
        {view.snoozeWakeLabel}
      </span>
    );

  const dragDestination = dropVerb !== null ? <DragDestination verb={dropVerb} t={t} /> : null;

  const metaLine = metaLineEmpty ? null : (
    <div className="t3-thread-row__meta">
      {view.branch ? (
        <>
          <ThreadWorktreeIndicator worktreePath={view.worktreePath} branch={view.branch} />
          <span className="t3-thread-row__branch">
            <span className="t3-thread-row__branch-name">{view.branch}</span>
          </span>
        </>
      ) : (
        <span className="t3-thread-row__spacer" />
      )}
      <ThreadDiffCount diff={view.diff} />
    </div>
  );

  const hoverCard = (
    <ThreadHoverCardPopup>
      <ThreadHoverCard title={view.title}>
        {view.projectDisplayName !== null ? (
          <div className="t3-thread-row__hover-row">
            <ProjectFavicon project={view.project} className="t3-icon--xs" />
            <div className="t3-thread-row__hover-line t3-thread-row__dim">{view.projectDisplayName}</div>
          </div>
        ) : null}
        {view.branch !== null ? (
          <div className="t3-thread-row__hover-row">
            <span className="t3-thread-row__branch-name t3-thread-row__dim">
              {view.branch}
            </span>
          </div>
        ) : null}
        {view.modelLabel !== null ? (
          <div className="t3-thread-row__hover-line t3-thread-row__dim">{view.modelLabel}</div>
        ) : null}
        {statusLabel !== null ? (
          <div className={cx("t3-thread-row__hover-line", topStatus?.className)}>{statusLabel}</div>
        ) : null}
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );

  return (
    <li
      data-thread-item={view.threadKey}
      {...sortableProps}
      {...fileDropHandlers}
      className={cx(
        "t3-thread-row",
        ((variant === "slim" && navigationParent === "shelf:settled") || variant === "folder") &&
          "t3-thread-row--compact",
        variant === "card" && "t3-thread-row--card",
        variant === "folder-multiline" && "t3-thread-row--multiline",
        variant === "folder-multiline" && metaLineEmpty && "t3-thread-row--multiline-bare",
        isDragging && "t3-thread-row--dragging",
      )}
    >
      <TooltipTrigger isDisabled={isDragging}>
        <Focusable excludeFromTabOrder>
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
              className={cx(
                rowSurfaceClassName,
                variant === "card"
                  ? undefined
                  : variant === "folder-multiline"
                    ? "t3-thread-row__surface--multiline"
                    : "t3-thread-row__surface--inline",
                inFolder && "t3-thread-row__surface--nested",
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
                onContextMenu?.(event.button === 2 ? { x: event.clientX, y: event.clientY } : null);
              }}
            >
          {renaming ? null : <span className="sr-only">{view.title}</span>}
          {variant === "card" ? (
            <div
              className={cx(
                "t3-thread-row__card",
                metaLineEmpty && "t3-thread-row__card--bare",
              )}
            >
              <div className="t3-thread-row__head">
                {draftIndicator}
                <ProjectFavicon project={view.project} className="t3-icon--md" />
                {pinIndicator}
                {view.projectDisplayName !== null ? (
                  <span className="t3-thread-row__project">
                    {view.projectDisplayName}
                  </span>
                ) : (
                  <span className="t3-thread-row__spacer" />
                )}
                {isDragging ? (
                  dragDestination
                ) : (
                  <span className="t3-g-sidebar-status-slot t3-thread-row__status-slot">
                    <span
                      className={cx(
                        !view.isWoke && "t3-thread-row__status--passive",
                        "t3-thread-row__status",
                      )}
                    >
                      {view.isWoke ? (
                        wokeButton
                      ) : topStatus !== null ? (
                        <span
                          className={cx(
                            "t3-thread-row__status-chip",
                            topStatus.className,
                          )}
                        >
                          <TopStatusIcon icon={topStatus.icon} className="t3-icon--md" />
                          {status === "working" && view.workingStartedAt !== null ? (
                            <span aria-hidden title={t(topStatus.labelKey)}>
                              <WorkingDuration startedAt={view.workingStartedAt} />
                            </span>
                          ) : (
                            t(topStatus.labelKey)
                          )}
                        </span>
                      ) : (
                        clockTime
                      )}
                    </span>
                    {onArchive || onUnarchive || snoozeMenu || discardDraftButton ? (
                      <span className="t3-thread-row__actions">
                        {discardDraftButton}
                        {snoozeMenu}
                        {onUnarchive ? unarchiveButton : archiveButton}
                      </span>
                    ) : null}
                  </span>
                )}
              </div>
              <div className="t3-thread-row__title-row">{title}</div>
              {metaLine}
            </div>
          ) : (
            <>
              <div
                className={
                  variant === "folder-multiline"
                    ? "t3-thread-row__line"
                    : "t3-thread-row__line--flat"
                }
              >
                {inFolder ? null : (
                  <span
                    className={cx(
                      "t3-thread-row__favicon",
                      !isActive &&
                        "t3-thread-row__favicon--dimmed",
                    )}
                  >
                    <ProjectFavicon project={view.project} className="t3-icon--md" />
                  </span>
                )}
                {draftIndicator}
                {title}
                {pinIndicator}
                {variant === "folder-multiline" ? null : (
                  <ThreadWorktreeIndicator worktreePath={view.worktreePath} branch={view.branch} />
                )}
                {isDragging ? (
                  dragDestination
                ) : (
                  <span className="t3-thread-row__trailing">
                    <span
                      className={cx(
                        "t3-thread-row__trailing-info",
                        !view.isWoke && "t3-thread-row__trailing-info--fading",
                      )}
                    >
                      {wakeTimeLabel ?? (view.isWoke ? (
                        <span className="t3-thread-row__status-chip t3-status--approval">
                          <TopStatusIcon icon="woke" className="t3-icon--xs" />
                          {t("sidebar.t3.status.woke")}
                        </span>
                      ) : inFolder && topStatus !== null ? (
                        <span
                          className={cx(
                            "t3-thread-row__status-chip",
                            topStatus.className,
                          )}
                        >
                          <TopStatusIcon icon={topStatus.icon} className="t3-icon--xs" />
                          {t(topStatus.labelKey)}
                        </span>
                      ) : (
                        clockTime
                      ))}
                    </span>
                    {onUnarchive ? unsnoozeButton : null}
                    {onArchive || onUnarchive ? (
                      <span className="t3-thread-row__actions">
                        {onUnarchive ? unarchiveButton : (
                          <>
                            {unsnoozeButton}
                            {archiveButton}
                          </>
                        )}
                      </span>
                    ) : null}
                  </span>
                )}
              </div>
              {variant === "folder-multiline" ? metaLine : null}
            </>
          )}
          {view.jumpLabel !== null ? <JumpHintBadge label={view.jumpLabel} /> : null}
            </div>
        </Focusable>
        {hoverCard}
      </TooltipTrigger>
    </li>
  );
});
