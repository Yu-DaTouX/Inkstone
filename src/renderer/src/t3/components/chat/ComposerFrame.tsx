import type { DragEvent, ReactNode } from "react";

import { cx } from "../../../ui/cx";
import { ComposerSurface } from "../ComposerSurface";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerStashBadge } from "./ComposerStashBadge";
import "./ComposerFrame.css";

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
  edgeHandles?: ReactNode;
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
  edgeHandles,
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
        <div className="t3-frame">
          <div
            data-chat-composer-form="true"
            className="t3-frame__form"
            {...dropProps}
          >
            <ComposerBanner.Dock>
              <ComposerBanner.Column>{banners}</ComposerBanner.Column>
              {stash && !stash.menuOpen && !menuLayer ? (
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
            <div className="t3-frame__main">
              <ComposerSurface.Main data-inline-resting-controls="true">
                <div
                  data-chat-composer-surface="true"
                  data-chat-composer-mobile-collapsed="false"
                  className={cx(
                    "t3-frame__surface",
                    (quoteActive || dropActive) && "t3-frame__surface--active",
                    surfaceClassName,
                  )}
                >
                  <div
                    data-chat-composer-body="true"
                    className="t3-frame__body"
                  >
                    {menuLayer}
                    {attachments}
                    {editor}
                  </div>
                  {notice}
                  <div
                    data-chat-composer-footer="true"
                    className="t3-frame__footer"
                  >
                    {footerLeading ? <div className="t3-frame__leading">{footerLeading}</div> : null}
                    <div
                      data-chat-composer-actions="right"
                      data-chat-composer-transition-actions="true"
                      data-chat-composer-primary-actions-compact="false"
                      className="t3-frame__actions"
                    >
                      <div
                        data-chat-composer-controls="footer"
                        data-chat-composer-footer-controls="true"
                        className="t3-frame__controls"
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
      {edgeHandles}
    </ComposerSurface.Shell>
  );
}
