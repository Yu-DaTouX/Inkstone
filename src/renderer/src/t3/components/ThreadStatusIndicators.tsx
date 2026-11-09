import { FolderGit2Icon } from "lucide-react";

import { useT } from "../../i18n";
import { cx } from "../../ui/cx";
import { Focusable, TooltipTrigger, Tooltip, TooltipHint } from "../../ui";
import "./ThreadStatusIndicators.css";

export interface ThreadDiff {
  insertions: number;
  deletions: number;
}

export function formatDiffCount(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
}

export function ThreadWorktreeIndicator({
  worktreePath,
  branch,
  className,
}: {
  worktreePath: string | null | undefined;
  branch: string | null | undefined;
  className?: string;
}) {
  const t = useT();
  const path = worktreePath?.trim();
  if (!path) return null;
  return (
    <TooltipTrigger>
      <Focusable excludeFromTabOrder><span role="img" aria-label={t("sidebar.t3.worktree", { path })} className={cx("t3-worktree-mark", className)}>
        <FolderGit2Icon className="t3-icon--sm" />
      </span></Focusable>
      <Tooltip><TooltipHint label={branch ? t("sidebar.t3.worktreeBranch", { path, branch }) : t("sidebar.t3.worktree", { path })} /></Tooltip>
    </TooltipTrigger>
  );
}

export function ThreadDiffCount({ diff, className }: { diff: ThreadDiff | null; className?: string }) {
  if (diff === null || (diff.insertions === 0 && diff.deletions === 0)) return null;
  return (
    <span className={cx("t3-diff-count", className)}>
      <span className="t3-diff-count__add">+{formatDiffCount(diff.insertions)}</span>{" "}
      <span className="t3-diff-count__del">−{formatDiffCount(diff.deletions)}</span>
    </span>
  );
}
