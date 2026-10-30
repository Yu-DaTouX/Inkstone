export function ComposerNotice({
  message,
  tone = "destructive",
  slot = "prompt-length",
}: {
  message: string | null;
  tone?: "destructive" | "warning";
  slot?: string;
}) {
  if (!message) return null;

  return (
    <p
      role="alert"
      className={
        tone === "warning"
          ? "px-3 pb-2 text-xs text-warning-foreground sm:px-4"
          : "px-3 pb-2 text-xs text-destructive sm:px-4"
      }
      data-chat-composer-validation={slot}
    >
      {message}
    </p>
  );
}

export function ComposerPromptLengthValidation({ message }: { message: string | null }) {
  return <ComposerNotice message={message} slot="prompt-length" />;
}
