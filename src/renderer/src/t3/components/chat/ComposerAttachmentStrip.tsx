import { PaperclipIcon, XIcon } from "lucide-react";
import { useRef } from "react";

import { useT } from "../../../i18n";
import { fmtSize } from "../../../features/composer/attachment-files";
import { cx } from "../../../ui/cx";
import { FileTypeIcon } from "../../../ui/FileTypeIcon";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "../../adapters/composer-attachments";
import { IconButton, TooltipTrigger, Tooltip, TooltipHint } from "../../../ui";
import "./ComposerAttachmentStrip.css";

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
      className="t3-attachments"
    >
      {images.map((image, index) => (
        <div
          key={image.id}
          data-chat-composer-expanded-image="true"
          className="t3-attachment"
        >
          <button
            type="button"
            className="t3-attachment__open"
            aria-label={t("composer.t3.previewImage", { name: image.name })}
            onClick={() => onExpandImage(image.id)}
          >
            {image.previewUrl ? (
              <img
                src={image.previewUrl}
                alt={image.name}
              />
            ) : (
              <span className="t3-attachment__name">
                {image.name}
              </span>
            )}
          </button>
          <span className="t3-attachment__ref">
            {refLabel(index)}
          </span>
          <span className="t3-attachment__remove">
            <IconButton data-t3-btn variant="ghost" size="md" onPress={() => onRemoveImage(image.id)} aria-label={t("composer.t3.removeAttachment", { name: image.name })}>
              <XIcon />
            </IconButton>
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
    <div className="t3-attachment-files">
      {files.map((file) => (
        <div key={file.id} className="t3-attachment-file">
          <FileTypeIcon name={file.name} size={16} mono />
          <button
            type="button"
            disabled={!file.isDirectory && !file.name}
            className="t3-attachment-file__name"
            onClick={() => onPreviewFile(file.id)}
          >
            {file.name}
          </button>
          <span className="t3-attachment-file__size">
            {file.isDirectory ? t("composer.dir") : fmtSize(file.sizeBytes)}
          </span>
          <IconButton data-t3-btn variant="ghost" size="md" onPress={() => onRemoveFile(file.id)} aria-label={t("composer.t3.removeAttachment", { name: file.name })}>
            <XIcon />
          </IconButton>
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
        className="t3-attachment-input"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <TooltipTrigger>
        <IconButton data-t3-btn variant="ghost" size="md" preventFocusOnPress onPress={() => inputRef.current?.click()} className={cx("t3-attach-btn", className)} aria-label={label}>
          <PaperclipIcon className="t3-attach-icon" />
        </IconButton>
        <Tooltip><TooltipHint label={label} /></Tooltip>
      </TooltipTrigger>
    </>
  );
}
