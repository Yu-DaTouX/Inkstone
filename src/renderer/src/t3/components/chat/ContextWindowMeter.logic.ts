export interface ContextWindowCostLike {
  readonly amount: number;
  readonly currency: string;
}
export function formatContextWindowCost(cost: ContextWindowCostLike): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}
