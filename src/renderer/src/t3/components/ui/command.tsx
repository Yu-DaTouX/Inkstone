import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";
import { ScrollArea } from "./scroll-area";

function Command({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("relative flex min-h-0 w-full flex-col", className)}
      data-slot="command"
      {...props}
    />
  );
}

function CommandList({ className, ...props }: ComponentProps<"div">) {
  return (
    <ScrollArea scrollbarGutter scrollFade>
      <div
        className={cn("not-empty:scroll-py-2 not-empty:p-2", className)}
        data-slot="command-list"
        {...props}
      />
    </ScrollArea>
  );
}

function CommandGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("[[role=group]+&]:mt-1.5", className)}
      data-slot="command-group"
      role="group"
      {...props}
    />
  );
}

function CommandItem({
  className,
  active,
  ...props
}: ComponentProps<"div"> & { active?: boolean }) {
  return (
    <div
      className={cn(
        "flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-base outline-none hover:bg-accent data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='text-'])]:text-muted-foreground",
        "py-1.5 data-selected:bg-foreground/[0.06] [&[data-selected]]:text-foreground",
        active && "bg-accent! text-accent-foreground!",
        className,
      )}
      data-active={active || undefined}
      data-slot="command-item"
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-secondary-label text-xs tracking-widest",
        className,
      )}
      data-slot="command-shortcut"
      {...props}
    />
  );
}

export { Command, CommandGroup, CommandItem, CommandList, CommandShortcut };
