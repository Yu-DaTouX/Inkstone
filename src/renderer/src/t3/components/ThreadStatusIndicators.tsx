import { FolderGit2Icon } from "lucide-react";

import { useT } from "../../i18n";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

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
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={t("sidebar.t3.worktree", { path })}
            className={cn("inline-flex shrink-0 items-center justify-center", className)}
          />
        }
      >
        <FolderGit2Icon className="size-3.5 shrink-0 text-icon-muted" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {branch ? t("sidebar.t3.worktreeBranch", { path, branch }) : t("sidebar.t3.worktree", { path })}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ThreadDiffCount({ diff, className }: { diff: ThreadDiff | null; className?: string }) {
  if (diff === null || (diff.insertions === 0 && diff.deletions === 0)) return null;
  return (
    <span className={cn("shrink-0 font-mono", className)}>
      <span className="text-diff-addition-foreground">+{formatDiffCount(diff.insertions)}</span>{" "}
      <span className="text-diff-deletion-foreground">−{formatDiffCount(diff.deletions)}</span>
    </span>
  );
}
