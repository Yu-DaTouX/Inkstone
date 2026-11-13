import type { ComponentType } from "react";
import { Globe, FolderCodeIcon } from "../../ui/icons";

import { cx } from "../../ui/cx";
import { useProjectIconLook } from "../../patterns/project-icon";
import "./ProjectFavicon.css";

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
        className={cx(
          "t3-favicon t3-favicon--web",
          className,
        )}
      >
        <Globe />
      </span>
    );
  }
  const label = project.displayName.trim();
  if (label.length === 0) {
    const Icon = FallbackIcon ?? FolderCodeIcon;
    return <Icon className={cx("t3-favicon-fallback", className)} />;
  }
  const tone = look.tone;
  return (
    <span
      aria-hidden
      className={cx(
        "t3-favicon t3-favicon--initials",
        className,
      )}
      style={{
        color: `color-mix(in srgb, var(--data-${tone}) 62%, var(--fg))`,
        backgroundColor: `color-mix(in srgb, var(--data-${tone}) 16%, transparent)`,
      }}
    >
      {look.text}
    </span>
  );
}
