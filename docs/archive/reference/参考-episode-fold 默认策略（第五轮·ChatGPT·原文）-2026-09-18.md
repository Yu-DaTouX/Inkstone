# 参考 · episode-fold 默认策略（第五轮 · ChatGPT 原文）

> **这是外部意见，不是本项目的决定。** 会话：<https://chatgpt.com/c/6aabcdf7-38d8-83ec-b86c-8b61aa987d9e>（2026-09-18）。
> 存档方式：该会话的「复制回复」按钮会失败，本文是用无障碍树文本重排得到的全文，只做了分段与列表符号的还原，未改动措辞。
> 逐条核查结论见 [方案 §17.5.6](../../dev/../design/方案-上下文工具内的自动压缩-2026-09-15.md)。

## 我问的问题（原文）

Round 5: episode-fold default switch. My pi extension generates a TaskState (objective/constraints/nextActions/hypothesis) and injects it into context. You argued default-on with a long-session gate, told me not to wait for A/B, and listed 5 P0 hardening items: cut TaskState recursion, derived/authoritative contract header, add provenance, disable legacy EpisodeState semantics, and add a split kill switch. Now 4 of 5 are done. Missing only provenance: deterministic reducer fields carry real entryIds, but model-produced semantic fields have no supportingEntryIds, so nothing validates that the entry exists and is <= sourceHead before persisting. Measured stateOverhead 4.6 percent. No A/B or Lost Constraint Rate data yet.

- Q1: does the missing provenance justify postponing the default change, or is it shippable later? Which failure class does provenance actually prevent?
- Q2: I lean default-off plus a visible settings entry plus one per-install notice; you argued default-on. Which is right?
- Q3: if default-off, what decidable criterion should move it to default-on?

## Q1 — Missing provenance does not block shipping Episode Fold as an opt-in feature, but it does block the default-on change.

supportingEntryIds is primarily an integrity / evidence-lineage control, not a performance control. It prevents a specific failure class: unsupported semantic state becoming durable context.

Concretely, without provenance, a model-produced hypothesis, constraint, nextAction, or even objective can be wrong once and then survive through:

model inference → persisted TaskState → previousState input → next TaskState → context injection

Even though you fixed literal TaskState recursion, semantic recursion through previousState still exists by design. Provenance lets you reject or invalidate a semantic claim when its supposed support:

- does not exist;
- belongs after sourceHead;
- belongs to the wrong ancestry/branch;
- was removed/replaced;
- or otherwise cannot be tied to evidence available when the snapshot was produced.

The important failure class is therefore evidence laundering / persistent semantic hallucination, plus branch/snapshot contamination. It also gives you deterministic auditability.

So my position is:

Ship the implementation if you want, but don't flip the default until provenance is enforced.

The 4.6% overhead is already acceptable and isn't the blocker.

## Q2 — At the state you describe now, default-off is the correct choice.

I would revise my earlier default-on recommendation because one of the things I classified as P0 is still missing. Default-on made sense under the assumption that the integrity hardening set was complete.

Your proposed policy is reasonable:

default-off + visible setting + one one-time install notice

No need to wait for a full A/B experiment before exposing it. But there's a meaningful distinction between available without evidence and enabled globally without an integrity invariant.

I would not make "no A/B / no Lost Constraint Rate yet" by itself a reason to stay default-off indefinitely. The blocking item is provenance, not the absence of experimentation.

## Q3 — Use a deterministic promotion gate, not "we feel confident now."

I would move it to default-on when all of these are true:

1. **Provenance invariant is complete**: every persisted model-produced semantic field either has ≥1 valid supportingEntryId, or is explicitly typed as an allowed inference with its evidence dependencies; every referenced entry exists, belongs to the valid ancestry, and entryId <= sourceHead.
2. **Integrity violations fail closed**: invalid provenance causes that field to be dropped/staled, not the entire TaskState accepted and not the whole feature catastrophically disabled.
3. **Production observation shows no material regression**: over a fixed sample such as ≥100 long-session folds or ≥20 qualifying sessions, whichever is larger, you observe zero confirmed constraint/objective corruption caused by Episode Fold.
4. **Quality metric clears a predefined bar**: Lost Constraint Rate with fold is not worse than baseline by more than a fixed tolerance, e.g. ΔLCR ≤ +1 percentage point; ideally it improves it.
5. **Operational metrics remain bounded**: p95 state overhead stays below your chosen ceiling. With your present 4.6%, something like <8% p95 leaves reasonable headroom.

The key promotion rule can therefore be expressed mechanically:

```
defaultOn =
  provenanceInvariantComplete
  && failClosedVerified
  && qualifyingFolds >= 100
  && confirmedSemanticCorruptions == 0
  && deltaLostConstraintRate <= 1pp
  && p95StateOverhead < 8%
```

I would not require a statistically powered A/B win before default-on. You're establishing that the mechanism is safe and non-regressive, not proving that it maximizes benchmark performance.

So the decision for Round 5 is: keep Episode Fold default-off now; complete provenance; then promote based on explicit integrity + non-regression gates rather than another subjective review round.
