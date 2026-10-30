import type { DragEvent, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ComposerSurface } from "../ComposerSurface";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerStashBadge } from "./ComposerStashBadge";

export interface ComposerFrameStash {
  readonly count: number;
  readonly menuOpen: boolean;
  readonly pulseKey: number;
  readonly label: string;
  readonly ariaLabel: string;
  readonly onToggleMenu: () => void;
}

export interface ComposerFrameDropProps {
  readonly onDragEnter: (event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
}

export interface ComposerFrameProps {
  editor?: ReactNode;
  menuLayer?: ReactNode;
  banners?: ReactNode;
  attachments?: ReactNode;
  notice?: ReactNode;
  footerLeading?: ReactNode;
  controls?: ReactNode;
  primaryActions?: ReactNode;
  contextStrip?: ReactNode;
  stash?: ComposerFrameStash | null;
  dropActive?: boolean;
  quoteActive?: boolean;
  dropProps?: ComposerFrameDropProps;
  className?: string;
  surfaceClassName?: string;
}

export function ComposerFrame({
  editor,
  menuLayer,
  banners,
  attachments,
  notice,
  footerLeading,
  controls,
  primaryActions,
  contextStrip,
  stash = null,
  dropActive = false,
  quoteActive = false,
  dropProps,
  className,
  surfaceClassName,
}: ComposerFrameProps) {
  return (
    <ComposerSurface.Shell contextRow={!!contextStrip} className={className}>
      <ComposerSurface.Host>
        <div className="relative z-10">
          <div
            data-chat-composer-form="true"
            className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
            {...dropProps}
          >
            <ComposerBanner.Dock>
              <ComposerBanner.Column>{banners}</ComposerBanner.Column>
              {stash ? (
                <ComposerStashBadge
                  count={stash.count}
                  menuOpen={stash.menuOpen}
                  pulseKey={stash.pulseKey}
                  label={stash.label}
                  ariaLabel={stash.ariaLabel}
                  onToggleMenu={stash.onToggleMenu}
                />
              ) : null}
            </ComposerBanner.Dock>
            <div className="relative">
              <ComposerSurface.Main data-inline-resting-controls="true">
                <div
                  data-chat-composer-surface="true"
                  data-chat-composer-mobile-collapsed="false"
                  className={cn(
                    "rounded-2xl transition-[background-color] duration-200",
                    "in-data-[thread-context-over]:bg-accent/45 in-data-[thread-context-over]:ring-1 in-data-[thread-context-over]:ring-inset in-data-[thread-context-over]:ring-primary/70",
                    quoteActive && "bg-accent/45 ring-1 ring-inset ring-primary/70",
                    dropActive && "bg-accent/45 ring-1 ring-inset ring-primary/70",
                    surfaceClassName,
                  )}
                >
                  <div
                    data-chat-composer-body="true"
                    className="relative px-4 pb-2 pt-3.5 sm:pt-4"
                  >
                    {menuLayer}
                    {attachments}
                    {editor}
                  </div>
                  {notice}
                  <div
                    data-chat-composer-footer="true"
                    className="flex min-w-0 flex-nowrap items-center overflow-visible px-2 pb-2"
                  >
                    {footerLeading ? <div className="me-2">{footerLeading}</div> : null}
                    <div
                      data-chat-composer-actions="right"
                      data-chat-composer-transition-actions="true"
                      data-chat-composer-primary-actions-compact="false"
                      className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-2"
                    >
                      <div
                        data-chat-composer-controls="footer"
                        data-chat-composer-footer-controls="true"
                        className="relative flex min-w-0 flex-1 items-center justify-end gap-0.5"
                      >
                        {controls}
                      </div>
                      {primaryActions}
                    </div>
                  </div>
                </div>
              </ComposerSurface.Main>
            </div>
          </div>
        </div>
        {contextStrip ? (
          <ComposerSurface.ContextStrip>{contextStrip}</ComposerSurface.ContextStrip>
        ) : null}
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
  );
}
