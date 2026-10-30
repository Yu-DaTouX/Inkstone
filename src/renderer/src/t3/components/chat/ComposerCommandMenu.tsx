import { Folder } from "lucide-react";
import { memo, useLayoutEffect, useRef } from "react";

import type { SlashCommand } from "../../../../../shared/ipc";
import { useT } from "../../../i18n";
import { InlineImage } from "../../../ui/InlineImage";
import { cn } from "../../lib/utils";
import { FileTypeIcon } from "../../../ui/FileTypeIcon";
import { Kbd } from "../ui/kbd";
import { Command, CommandGroup, CommandItem, CommandList } from "../ui/command";
import { ComposerBanner } from "./ComposerBanner";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: SlashCommand;
      label: string;
      description: string;
      sourceLabel: string;
    }
  | {
      id: string;
      type: "image";
      label: string;
      name: string;
      preview: string;
    };

export type ComposerCommandTriggerKind = "path" | "slash-command";

export interface ComposerCommandMenuProps {
  listId: string;
  items: readonly ComposerCommandItem[];
  isLoading: boolean;
  triggerKind: ComposerCommandTriggerKind | null;
  activeItemId: string | null;
  total: number;
  error: "slash" | "permission" | "path" | null;
  onRetry?: () => void;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(
  props: ComposerCommandMenuProps,
) {
  const t = useT();
  const surfaceRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!props.activeItemId || !surfaceRef.current) return;
    const el = surfaceRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  const slashMode = props.triggerKind === "slash-command";
  const emptyText = slashMode ? t("composer.t3.menu.noCommand") : t("composer.t3.menu.noFiles");
  const errorText =
    props.error === "slash"
      ? t("composer.slashError")
      : props.error === "permission"
        ? t("composer.pathPermission")
        : t("composer.pathError");

  return (
    <Command data-composer-command-root="true">
      <ComposerBanner.Surface
        ref={surfaceRef}
        className="flex min-h-0 w-full flex-col overflow-hidden pb-(--chat-composer-attachment-overlap) **:data-[slot=command-item]:rounded-lg **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4"
        data-composer-command-drawer="true"
      >
        {props.error ? (
          <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-7 text-secondary-label text-xs">
            <span>{errorText}</span>
            {props.onRetry ? (
              <button
                type="button"
                className="rounded-(--control-radius) px-1.5 py-0.5 font-medium text-foreground text-xs hover:bg-accent"
                onMouseDown={(event) => event.preventDefault()}
                onClick={props.onRetry}
              >
                {t("composer.slashRetry")}
              </button>
            ) : null}
          </div>
        ) : props.items.length > 0 ? (
          <CommandList
            id={props.listId}
            role="listbox"
            aria-label={slashMode ? t("composer.t3.menu.commands") : t("composer.t3.menu.files")}
            className="max-h-72 min-h-0 scroll-pb-6"
          >
            <CommandGroup>
              {props.items.map((item, index) => (
                <CommandMenuItem
                  key={item.id}
                  optionId={composerSuggestionOptionId(props.listId, item.id)}
                  item={item}
                  previous={props.items[index - 1]}
                  isActive={props.activeItemId === item.id}
                  onHighlight={props.onHighlightedItemChange}
                  onSelect={props.onSelect}
                />
              ))}
            </CommandGroup>
          </CommandList>
        ) : (
          <div className="px-5 pt-3.5 pb-7">
            <p className="text-secondary-label text-xs">
              {props.isLoading ? t("composer.t3.menu.searching") : emptyText}
            </p>
          </div>
        )}
        <div
          className="flex items-center gap-2 border-border border-t px-3 py-1.5 text-secondary-label text-3xs"
          data-slot="composer-command-footer"
        >
          <span className="inline-flex items-center gap-1">
            <Kbd>↑↓</Kbd>
            {t("composer.slashSelect")}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Enter</Kbd>
            {t("composer.slashFill")}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Esc</Kbd>
            {t("composer.slashClose")}
          </span>
          <span className="ms-auto tabular-nums">
            {t("composer.slashCount", { n: props.total })}
          </span>
        </div>
      </ComposerBanner.Surface>
    </Command>
  );
});

const CommandMenuItem = memo(function CommandMenuItem(props: {
  optionId: string;
  item: ComposerCommandItem;
  previous: ComposerCommandItem | undefined;
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const { item, isActive } = props;
  const t = useT();
  const groupLabel =
    item.type === "slash-command"
      ? props.previous?.type === "slash-command" && props.previous.sourceLabel === item.sourceLabel
        ? null
        : item.sourceLabel
      : item.type === "image" && props.previous?.type !== "image"
        ? t("composer.imageRefGroup")
        : null;

  return (
    <>
      {groupLabel ? (
        <div
          className="px-2 py-1.5 font-medium text-muted-foreground text-xs"
          data-slot="command-group-label"
          role="presentation"
        >
          {groupLabel}
        </div>
      ) : null}
      <CommandItem
        id={props.optionId}
        role="option"
        aria-selected={isActive}
        aria-disabled={item.type === "slash-command" && !item.command.executable}
        data-composer-item-id={item.id}
        active={isActive}
        onMouseMove={() => {
          if (!isActive) props.onHighlight(item.id);
        }}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => {
          props.onSelect(item);
        }}
      >
        {item.type === "path" ? (
          item.path.endsWith("/") ? (
            <Folder aria-hidden="true" className="size-4 shrink-0 text-secondary-label" />
          ) : (
            <FileTypeIcon name={item.path} size={16} className="shrink-0" />
          )
        ) : null}
        {item.type === "image" ? (
          <InlineImage
            className="size-4 shrink-0 rounded-[3px] object-cover"
            src={item.preview}
            alt=""
          />
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              "min-w-0 max-w-[45%] shrink-0 truncate font-sans text-xs font-medium",
              item.type === "slash-command" && !item.command.executable && "text-secondary-label",
            )}
          >
            {item.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-left text-secondary-label text-xs">
            {item.type === "image" ? item.name : item.description}
          </span>
        </span>
      </CommandItem>
    </>
  );
});
