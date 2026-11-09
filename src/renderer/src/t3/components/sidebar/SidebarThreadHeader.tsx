import { FolderPlusIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import type { PressEvent } from "react-aria-components";
import { useT } from "../../../i18n";
import { focusSnippet, splitSnippet, type ContentMatch } from "../../../features/sidebar/content-search";
import { cx } from "../../../ui/cx";
import { Badge, IconButton, Input } from "../../../ui";
import "./SidebarThreadHeader.css";

export interface SidebarThreadHeaderProps {
  searchFieldRef?: RefObject<HTMLDivElement | null>;
  hasProjects: boolean;
  projectScope: ReactNode;
  onNewProject: () => void;
  onNewThread: (event: PressEvent) => void;
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
    <div className="t3-sidebar-header" data-testid="t3-sidebar-thread-header">
      <div
        ref={searchFieldRef}
        className="t3-sidebar-search"
      >
        <SearchIcon className="t3-icon--md" />
        <Input
          ref={searchInputRef}
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
          className="t3-sidebar-search__input"
        />
        {isSearching ? (
          <IconButton data-t3-btn variant="ghost" size="sm" onPress={() => {
              onClearSearch();
              searchInputRef.current?.focus();
            }} className="t3-sidebar-search__clear" aria-label={t("sidebar.t3.clearSearch")}>
            <XIcon className="t3-icon--xs" />
          </IconButton>
        ) : null}
      </div>
      <div className="t3-sidebar-header__actions">
        {hasProjects ? (
          <>
            {projectScope}
            <SidebarHeaderIconButton
              label={t("sidebar.t3.addProject")}
              onPress={() => onNewProject()}
            >
              <FolderPlusIcon />
            </SidebarHeaderIconButton>
          </>
        ) : null}
        <SidebarHeaderIconButton
          label={newThreadLabel}
          tooltip={
            showNewThreadInProjectHint ? (
              <span className="t3-sidebar-header__tip">
                <span>{newThreadLabel}</span>
                <span className="t3-sidebar-header__tip-detail">
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
          isDisabled={newThreadDisabled}
          onPress={onNewThread}
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
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
} & Omit<ComponentProps<typeof IconButton>, "aria-label" | "tooltip" | "variant" | "size" | "className">) {
  return (
    <IconButton
      data-t3-btn
      {...rest}
      variant="ghost"
      size="md"
      aria-label={label}
      tooltip={tooltip}
      className={cx("t3-sidebar-icon-btn t3-sidebar-icon-btn--header", className)}
    />
  );
}

export function SidebarThreadSearchStatus({ pending }: { pending: boolean }) {
  const t = useT();
  return (
    <p role="status" className="t3-sidebar-search-status">
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
      className="t3-sidebar-matches"
      data-testid="t3-sidebar-content-matches"
    >
      <span className="t3-sidebar-matches__title">
        <span className="t3-sidebar-matches__title-text">{t("sidebar.t3.contentMatches")}</span>
        <span className="t3-sidebar-matches__rule" />
        <span className="t3-sidebar-matches__count">{matches.length}</span>
      </span>
      {matches.length === 0 ? (
        <p role="status" className="t3-sidebar-matches__hint">
          {t("sidebar.t3.searching")}
        </p>
      ) : null}
      <ul role="list" className="t3-sidebar-matches__list">
        {matches.map((match) => (
          <li key={match.path}>
            <button
              type="button"
              onClick={() => onOpen(match)}
              aria-current={currentPath === match.path ? "true" : undefined}
              className="t3-sidebar-match"
              data-testid="t3-sidebar-content-match"
            >
              <span className="t3-sidebar-match__body">
                <span className="t3-sidebar-match__head">
                  <span className="t3-sidebar-match__title">
                    {match.title}
                  </span>
                  {match.archived ? (
                    <Badge>{t("sidebar.t3.archive")}</Badge>
                  ) : null}
                </span>
                <span className="t3-sidebar-match__snippet">
                  {splitSnippet(focusSnippet(match.snippet, query), query).map((part, index) =>
                    part.hit ? (
                      <mark key={index} className="t3-sidebar-match__mark">
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
