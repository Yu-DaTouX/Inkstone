import "./ComposerFrame.css";

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
      className={tone === "warning" ? "t3-prompt-error t3-prompt-error--warning" : "t3-prompt-error"}
      data-chat-composer-validation={slot}
    >
      {message}
    </p>
  );
}
