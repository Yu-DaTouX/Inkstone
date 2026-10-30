import { PaperclipIcon, XIcon } from "lucide-react";
import { useRef } from "react";

import { useT } from "../../../i18n";
import { fmtSize } from "../../../features/composer/attachment-files";
import { FileTypeIcon } from "../../../ui/FileTypeIcon";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "../../adapters/composer-attachments";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ComposerAttachmentMediaRow({
  images,
  refLabel,
  onExpandImage,
  onRemoveImage,
}: {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly refLabel: (index: number) => string;
  readonly onExpandImage: (imageId: string) => void;
  readonly onRemoveImage: (imageId: string) => void;
}) {
  const t = useT();
  if (images.length === 0) return null;
  return (
    <div
      data-chat-composer-media-row="true"
      className="mb-3 flex max-w-full flex-wrap gap-2"
    >
      {images.map((image, index) => (
        <div
          key={image.id}
          data-chat-composer-expanded-image="true"
          className="group/attachment relative h-16 w-16 shrink-0 snap-start overflow-hidden rounded-lg border border-border/80 bg-background"
        >
          <button
            type="button"
            className="h-full w-full cursor-zoom-in"
            aria-label={t("composer.t3.previewImage", { name: image.name })}
            onClick={() => onExpandImage(image.id)}
          >
            {image.previewUrl ? (
              <img
                src={image.previewUrl}
                alt={image.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="flex h-full items-center justify-center px-1 text-3xs text-secondary-label">
                {image.name}
              </span>
            )}
          </button>
          <span className="pointer-events-none absolute left-1 top-1 inline-flex items-center rounded-sm bg-background/85 px-1 text-5xs tabular-nums text-muted-foreground">
            {refLabel(index)}
          </span>
          <span className="absolute right-1 top-1 flex">
            <Button
              variant="media-close"
              size="icon-xs"
              onClick={() => onRemoveImage(image.id)}
              aria-label={t("composer.t3.removeAttachment", { name: image.name })}
            >
              <XIcon />
            </Button>
          </span>
        </div>
      ))}
    </div>
  );
}

export function ComposerAttachmentFileList({
  files,
  onPreviewFile,
  onRemoveFile,
}: {
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly onPreviewFile: (fileId: string) => void;
  readonly onRemoveFile: (fileId: string) => void;
}) {
  const t = useT();
  if (files.length === 0) return null;
  return (
    <div className="mb-3 flex flex-col gap-1">
      {files.map((file) => (
        <div key={file.id} className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground">
          <FileTypeIcon name={file.name} size={16} mono />
          <button
            type="button"
            disabled={!file.isDirectory && !file.name}
            className="min-w-0 flex-1 truncate text-left hover:underline focus-visible:outline-2"
            onClick={() => onPreviewFile(file.id)}
          >
            {file.name}
          </button>
          <span className="shrink-0 text-xs text-secondary-label">
            {file.isDirectory ? t("composer.dir") : fmtSize(file.sizeBytes)}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onRemoveFile(file.id)}
            aria-label={t("composer.t3.removeAttachment", { name: file.name })}
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  );
}

export function ComposerAttachButton({
  onFiles,
  className,
}: {
  readonly onFiles: (files: File[]) => void;
  readonly className?: string;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const label = t("composer.t3.attachFiles");
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={className}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => inputRef.current?.click()}
              aria-label={label}
            />
          }
        >
          <PaperclipIcon className="translate-y-px" />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    </>
  );
}
