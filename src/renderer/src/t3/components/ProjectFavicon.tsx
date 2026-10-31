import type { ComponentType } from "react";
import { Globe, FolderCodeIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { useProjectIconLook } from "../../patterns/project-icon";

export { projectMonogram } from "../../patterns/project-icon";

export interface ProjectFaviconProject {
  projectId: string;
  displayName: string;
  global?: boolean;
}

export function ProjectFavicon({
  project,
  className,
  fallbackIcon: FallbackIcon,
}: {
  project: ProjectFaviconProject | null;
  className?: string;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  const look = useProjectIconLook(project?.projectId, project?.displayName.trim() ?? "");
  if (project === null) return null;
  if (project.global === true) {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-[.25rem] bg-[color-mix(in_srgb,var(--data-8)_18%,transparent)] text-[color-mix(in_srgb,var(--data-8)_70%,var(--color-foreground))]",
          className,
        )}
      >
        <Globe className="size-2.5" />
      </span>
    );
  }
  const label = project.displayName.trim();
  if (label.length === 0) {
    const Icon = FallbackIcon ?? FolderCodeIcon;
    return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", className)} />;
  }
  const tone = look.tone;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[.25rem] text-[.5rem] font-semibold leading-none tracking-tight",
        className,
      )}
      style={{
        color: `color-mix(in srgb, var(--data-${tone}) 78%, var(--color-foreground))`,
        backgroundColor: `color-mix(in srgb, var(--data-${tone}) 16%, transparent)`,
      }}
    >
      {look.text}
    </span>
  );
}
