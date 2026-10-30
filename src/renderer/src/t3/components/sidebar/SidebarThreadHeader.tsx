import { FolderPlusIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { useT } from "../../../i18n";
import { focusSnippet, splitSnippet, type ContentMatch } from "../../../features/sidebar/content-search";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input, type InputProps } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const SIDEBAR_MENU_BUTTON =
  "peer/menu-button flex w-full cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden text-left font-medium text-sidebar-muted-foreground/80 outline-hidden ring-ring transition-[width,height,padding] hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset active:bg-sidebar-row-active active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground data-[state=open]:hover:bg-sidebar-row-hover data-[state=open]:hover:text-sidebar-foreground [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground active:[&>svg]:text-sidebar-foreground data-[active=true]:[&>svg]:text-sidebar-foreground";

export const SIDEBAR_MENU_ICON_BUTTON =
  "size-8 justify-center rounded-[var(--control-radius)] p-0";

function SidebarSearchInput({ className, ...props }: Omit<InputProps, "unstyled">) {
  return (
    <Input
      className={cn(
        "[&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground",
        className,
      )}
      unstyled
      {...props}
    />
  );
}

export interface SidebarThreadHeaderProps {
  searchFieldRef?: RefObject<HTMLDivElement | null>;
  hasProjects: boolean;
  projectScope: ReactNode;
  onNewProject: () => void;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  showNewThreadInProjectHint: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  searchFieldRef,
  hasProjects,
  projectScope,
  onNewProject,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const t = useT();
  const resultsVisible = isSearching && searchResultCount > 0;
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? t("sidebar.t3.newThreadWithShortcut", { keys: newThreadShortcutLabel })
    : t("sidebar.t3.newThread");

  return (
    <div className="flex items-center gap-1" data-testid="t3-sidebar-thread-header">
      <div
        ref={searchFieldRef}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70"
      >
        <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
        <SidebarSearchInput
          ref={searchInputRef}
          nativeInput
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={t("sidebar.t3.search")}
          aria-label={t("sidebar.t3.searchThreads")}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={resultsVisible}
          aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
          aria-activedescendant={
            activeResultExists ? `sidebar-thread-search-result-${activeSearchResultIndex}` : undefined
          }
          className="min-w-0 flex-1"
        />
        {isSearching ? (
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            className="shrink-0"
            aria-label={t("sidebar.t3.clearSearch")}
            onClick={() => {
              onClearSearch();
              searchInputRef.current?.focus();
            }}
          >
            <XIcon className="size-3" />
          </Button>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">
        {hasProjects ? (
          <>
            {projectScope}
            <SidebarHeaderIconButton
              label={t("sidebar.t3.addProject")}
              onClick={() => onNewProject()}
            >
              <FolderPlusIcon />
            </SidebarHeaderIconButton>
          </>
        ) : null}
        <SidebarHeaderIconButton
          label={newThreadLabel}
          tooltip={
            showNewThreadInProjectHint ? (
              <span className="flex flex-col gap-0.5">
                <span>{newThreadLabel}</span>
                <span className="text-muted-foreground">
                  {t("sidebar.t3.newThreadInProject")}
                  {newThreadInProjectShortcutLabel
                    ? t("sidebar.t3.newThreadInProjectWithShortcut", {
                        keys: newThreadInProjectShortcutLabel,
                      })
                    : ""}
                </span>
              </span>
            ) : (
              newThreadLabel
            )
          }
          disabled={newThreadDisabled}
          onClick={onNewThread}
        >
          <SquarePenIcon />
        </SidebarHeaderIconButton>
      </div>
    </div>
  );
}

export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<"button">,
  "children" | "className" | "aria-label" | "type" | "title"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            {...rest}
            className={cn(SIDEBAR_MENU_BUTTON, SIDEBAR_MENU_ICON_BUTTON, "relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function SidebarThreadSearchStatus({ pending }: { pending: boolean }) {
  const t = useT();
  return (
    <p role="status" className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
      {pending ? t("sidebar.t3.searching") : t("sidebar.t3.noResults")}
    </p>
  );
}

export interface SidebarSearchContentMatchesProps {
  query: string;
  matches: readonly ContentMatch[];
  currentPath: string | undefined;
  onOpen: (match: ContentMatch) => void;
  pending?: boolean | undefined;
}

export function SidebarSearchContentMatches({
  query,
  matches,
  currentPath,
  onOpen,
  pending = false,
}: SidebarSearchContentMatchesProps) {
  const t = useT();
  if (matches.length === 0 && !pending) return null;
  return (
    <div
      role="group"
      aria-label={t("sidebar.t3.contentMatches")}
      aria-busy={pending}
      className="mt-1 flex flex-col gap-px"
      data-testid="t3-sidebar-content-matches"
    >
      <span className="flex h-8 items-center gap-2 px-2 text-xs font-medium text-sidebar-muted-foreground">
        <span className="truncate">{t("sidebar.t3.contentMatches")}</span>
        <span className="h-px flex-1 bg-sidebar-border/50" />
        <span className="text-xs tabular-nums">{matches.length}</span>
      </span>
      {matches.length === 0 ? (
        <p role="status" className="px-2 py-2 text-xs text-sidebar-muted-foreground">
          {t("sidebar.t3.searching")}
        </p>
      ) : null}
      <ul role="list" className="flex flex-col gap-px">
        {matches.map((match) => (
          <li key={match.path}>
            <button
              type="button"
              onClick={() => onOpen(match)}
              aria-current={currentPath === match.path ? "true" : undefined}
              className={cn(
                SIDEBAR_MENU_BUTTON,
                "h-auto items-start rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-1.5",
                currentPath === match.path && "bg-sidebar-row-selected",
              )}
              data-testid="t3-sidebar-content-match"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {match.title}
                  </span>
                  {match.archived ? (
                    <span className="shrink-0 rounded-sm border border-border/80 px-1 text-3xs text-muted-foreground">
                      {t("sidebar.t3.archive")}
                    </span>
                  ) : null}
                </span>
                <span className="truncate text-xs text-muted-foreground/85">
                  {splitSnippet(focusSnippet(match.snippet, query), query).map((part, index) =>
                    part.hit ? (
                      <mark key={index} className="bg-transparent font-semibold text-foreground">
                        {part.text}
                      </mark>
                    ) : (
                      <span key={index}>{part.text}</span>
                    ),
                  )}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
