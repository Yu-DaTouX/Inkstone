import { Folder } from "../../../ui/icons";
import { memo, useLayoutEffect, useRef } from "react";

import type { SlashCommand } from "../../../../../shared/ipc";
import { useT } from "../../../i18n";
import { InlineImage } from "../../../ui/InlineImage";
import { cx } from "../../../ui/cx";
import { FileTypeIcon } from "../../../ui/FileTypeIcon";
import { Button, Kbd, ScrollArea, StaticListBox, StaticListBoxItem } from "../../../ui";
import { ComposerBanner } from "./ComposerBanner";
import "./ComposerCommandMenu.css";

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
    <div data-composer-command-root="true" className="t3-cmd">
      <ComposerBanner.Surface
        ref={surfaceRef}
        className="t3-cmd__surface"
        data-composer-command-drawer="true"
      >
        {props.error ? (
          <div className="t3-cmd__error">
            <span>{errorText}</span>
            {props.onRetry ? (
              <Button variant="ghost" size="xs" preventFocusOnPress onPress={props.onRetry}>
                {t("composer.slashRetry")}
              </Button>
            ) : null}
          </div>
        ) : props.items.length > 0 ? (
          <ScrollArea fade className="t3-cmd__scroll">
            <StaticListBox
              id={props.listId}
              aria-label={slashMode ? t("composer.t3.menu.commands") : t("composer.t3.menu.files")}
              className="t3-cmd__list"
            >
            {props.items.map((item, index) => (
              <CommandMenuItem
                key={item.id}
                optionId={composerSuggestionOptionId(props.listId, item.id)}
                item={item}
                previous={props.items[index - 1]}
                isActive={props.activeItemId === item.id}
                onSelect={props.onSelect}
              />
            ))}
            </StaticListBox>
          </ScrollArea>
        ) : (
          <div className="t3-cmd__empty">
            <p>
              {props.isLoading ? t("composer.t3.menu.searching") : emptyText}
            </p>
          </div>
        )}
        <div
          className="t3-cmd__footer"
          data-slot="composer-command-footer"
        >
          <span className="t3-cmd__hint">
            <Kbd>↑↓</Kbd>
            {t("composer.slashSelect")}
          </span>
          <span className="t3-cmd__hint">
            <Kbd>Enter</Kbd>
            {t("composer.slashFill")}
          </span>
          <span className="t3-cmd__hint">
            <Kbd>Esc</Kbd>
            {t("composer.slashClose")}
          </span>
          <span className="t3-cmd__count">
            {t("composer.slashCount", { n: props.total })}
          </span>
        </div>
      </ComposerBanner.Surface>
    </div>
  );
});

const CommandMenuItem = memo(function CommandMenuItem(props: {
  optionId: string;
  item: ComposerCommandItem;
  previous: ComposerCommandItem | undefined;
  isActive: boolean;
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
          className="t3-cmd__group"
          data-slot="command-group-label"
          role="presentation"
        >
          {groupLabel}
        </div>
      ) : null}
      <StaticListBoxItem
        id={props.optionId}
        selected={isActive}
        aria-disabled={item.type === "slash-command" && !item.command.executable}
        data-composer-item-id={item.id}
        active={isActive}
        className="t3-cmd__item"
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => {
          props.onSelect(item);
        }}
      >
        {item.type === "path" ? (
          item.path.endsWith("/") ? (
            <Folder aria-hidden="true" className="t3-cmd__folder" />
          ) : (
            <FileTypeIcon name={item.path} size={16} className="t3-cmd__file-icon" />
          )
        ) : null}
        {item.type === "image" ? (
          <InlineImage
            className="t3-cmd__thumb"
            src={item.preview}
            alt=""
          />
        ) : null}
        <span className="t3-cmd__body">
          <span
            className={cx(
              "t3-cmd__label",
              item.type === "slash-command" && !item.command.executable && "t3-cmd__label--disabled",
            )}
          >
            {item.label}
          </span>
          <span className="t3-cmd__desc">
            {item.type === "image" ? item.name : item.description}
          </span>
        </span>
      </StaticListBoxItem>
    </>
  );
});
