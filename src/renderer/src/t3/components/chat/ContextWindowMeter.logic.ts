export interface ContextWindowCostLike {
  readonly amount: number;
  readonly currency: string;
}

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
  text?: {
    readonly atTokens: (tokens: string) => string;
    readonly forModel: (model: string) => string;
    readonly generic: string;
  },
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return text?.atTokens(autoCompactThreshold.toLocaleString("en-US")) ?? "";
  }
  if (modelDisplayName) return text?.forModel(modelDisplayName) ?? "";
  return text?.generic ?? "";
}

export function formatContextWindowCost(cost: ContextWindowCostLike): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}
