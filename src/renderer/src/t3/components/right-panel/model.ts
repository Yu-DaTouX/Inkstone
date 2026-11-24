import type { KeyboardEventHandler, ReactNode } from "react";

export type PanelMode = "inline" | "sheet";

export type T3SurfaceKind =
  | "changes"
  | "files"
  | "file"
  | "browser"
  | "terminal"
  | "pullRequests"
  | "pullRequest"
  | "device"
  | "context"
  | "branch"
  | "logs"
  | "quota"
  | "subagent"
  | "terminalTab"
  | "watch";

export interface T3Surface {
  id: string;
  kind: T3SurfaceKind;
  label: string;
  detail?: string;
  badge?: "pending" | "blocked";
  tone?: "open" | "draft" | "merged" | "closed";
}

export interface LauncherAction {
  kind: string;
  label: string;
  shortcut: string;
  icon: ReactNode;
  available: boolean;
  disabledReason?: string;
  onPick: () => void;
}

export interface SheetChrome {
  onClose: () => void;
  transitionMs?: number;
}

export interface PanelFrameProps {
  inlineExitMs?: number;
  mode: PanelMode;
  open: boolean;
  maximized?: boolean;
  width: number;
  room?: number;
  dock?: number;
  span?: number;
  minWidth?: number;
  onWidth: (width: number) => void;
  label: string;
  tabbar: ReactNode;
  tabbarClassName?: string;
  toggleSelector?: string;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  children: ReactNode;
  sheet?: SheetChrome;
  testId?: string;
}

export interface LauncherSection {
  reason: string | null;
  actions: LauncherAction[];
}

export function launcherSections(actions: readonly LauncherAction[]): LauncherSection[] {
  const sections: LauncherSection[] = [{ reason: null, actions: [] }];
  for (const action of actions) {
    if (action.available) {
      sections[0].actions.push(action);
      continue;
    }
    const reason = action.disabledReason ?? "";
    const section = sections.find((entry) => entry.reason === reason);
    if (section) section.actions.push(action);
    else sections.push({ reason, actions: [action] });
  }
  return sections.filter((section) => section.actions.length);
}
