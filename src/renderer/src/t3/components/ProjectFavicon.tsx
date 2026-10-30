import type { ComponentType } from "react";
import { Globe, FolderCodeIcon } from "lucide-react";

import { cn } from "../lib/utils";

export interface ProjectFaviconProject {
  projectId: string;
  displayName: string;
  global?: boolean;
}

const PROJECT_TONES = 7;

export function projectMonogram(label: string): string {
  const words = label.trim().split(/[\s._\-/\\]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]!];
  if (!/^[\x00-\x7f]+$/.test(words[0]!)) return first[0]!;
  const digit = first.slice(1).find((char) => /\d/.test(char));
  const second = digit ?? (words.length > 1 ? [...words[words.length - 1]!][0] : (first[1] ?? ""));
  return (first[0]! + second).toUpperCase();
}

export function projectTone(label: string): number {
  let hash = 0;
  for (const char of label.toLowerCase()) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return (hash % PROJECT_TONES) + 1;
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
  const tone = projectTone(label);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[.25rem] text-[.5rem] font-semibold leading-none tracking-tight",
        className,
      )}
      style={{
        color: `color-mix(in srgb, var(--data-${tone}) 78%, var(--color-foreground))`,
        backgroundColor: `color-mix(in srgb, var(--data-${tone}) 16%, transparent)`,
      }}
    >
      {projectMonogram(label)}
    </span>
  );
}
