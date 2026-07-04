# Refund scenario cross-check (mock data ↔ policy)

This manifest cross-checks every one of the 15 CRM profiles against `refund-policy.md` (Step 2
adversarial focus: *every clause exercised by ≥1 profile; every profile has an unambiguous correct
outcome*). It is the oracle the Step 3 eligibility engine and its tests must reproduce. Outcomes
follow the policy's **decision precedence** (first matching rule wins).

Dates are relative offsets, so these outcomes hold on **any** run date.

| Customer | Order | Scenario | Expected outcome | Clause(s) | Refund |
| --- | --- | --- | --- | --- | --- |
| cus_01 Avery Stone | ord_1001 | Physical item, delivered 10d ago, no complications | **APPROVE (full)** | R1 | $129.00 |
| cus_02 Blake Morgan | ord_1002 | Physical item, delivered 60d ago | **DECLINE** | R1 (out of window) | — |
| cus_03 Casey Rivera | ord_1003 | Final-sale sneakers, delivered 5d ago | **DECLINE** | R2 | — |
| cus_04 Devon Chen | ord_1004 | Digital course, delivered/accessed 3d ago | **DECLINE** | R3 | — |
| cus_05 Emerson Blake | ord_1005 | $1,299 TV, delivered 8d ago (would pass R1) | **ESCALATE** | R4 (> $500) | — |
| cus_06 Finley Nguyen | ord_1006 | In-window speaker already fully refunded | **DECLINE** | R5 | — |
| cus_07 Gray Patel | ord_1001 | Requests an order that belongs to **cus_01** | **DECLINE** | R6 (ownership) | — |
| cus_08 Harper Diaz | ord_1008 | Abuse-flagged account, in-window shoes | **ESCALATE** | R8 | — |
| cus_09 Indigo Price | ord_1009 | Damaged vase, delivered 7d ago | **APPROVE (full)** | R7 | $60.00 |
| cus_10 Jordan Lee | ord_1010 | Defective coffee maker, delivered 45d ago (past R1) | **APPROVE (full)** | R7 overrides R1 | $140.00 |
| cus_11 Kai Robinson | ord_1011 | Damaged plates ($70) + final-sale napkins ($20) | **APPROVE (partial)** | R9 + R7 (plates), R2 (napkins excluded) | $70.00 |
| cus_12 Logan Kim | ord_1012 | Damaged blender, delivered 120d ago (past R7's 90d) | **DECLINE** | R1 (R7 window expired) | — |
| cus_13 Morgan Tate | ord_1013 | $850 damaged handbag, delivered 5d ago | **ESCALATE** | R4 outranks R7 | — |
| cus_14 Riley Foster | ord_9999 | Requests a **non-existent** order id | **VERIFY / no decision** | R6 (unknown order) | — |
| cus_15 Quinn Adams | ord_1015 | Two normal items ($95 + $15), delivered 6d ago; 3 prior refunds but **not** flagged | **APPROVE (full)** | R1 (flag is explicit, not count-based) | $110.00 |
| cus_15 Quinn Adams | ord_1016 | $200 cookware, delivered 12d ago, **$80 already refunded** (partial) | **APPROVE (partial)** | R1 eligible + R9/R5 (remainder) | $120.00 |

## Clause coverage (every clause exercised ≥ 1×)

- **R1** — 30-day window: cus_01 (approve within), cus_02 (decline outside), cus_12 (decline after R7 expiry), cus_15.
- **R2** — final sale: cus_03 (decline), cus_11 (excluded item).
- **R3** — digital: cus_04.
- **R4** — > $500 escalation: cus_05, cus_13.
- **R5** — one refund per order: cus_06 (fully refunded → decline); cus_15/ord_1016 (partial prior → remainder).
- **R6** — ownership / identity: cus_07 (mismatch), cus_14 (unknown order).
- **R7** — damaged/defective 90-day window: cus_09, cus_10 (override R1), cus_11 (eligible item).
- **R8** — abuse review: cus_08.
- **R9** — partial refund: cus_11 (multi-item split); cus_15/ord_1016 (prior-partial remainder).

## Precedence demonstrations (why order matters)

- **R4 before R7** — cus_13: a damaged item that would approve under R7 still **escalates** because
  the order exceeds $500.
- **R8 before item rules** — cus_08: a flagged account **escalates** even though the order is in-window.
- **R7 overrides R1 & R2** — cus_10 (defective past 30d approves), cus_11 (damaged item approves
  despite the sibling final-sale item).
- **Flag is explicit, not count-based** — cus_15 has 3 prior refunds but no abuse flag, so it approves;
  cus_08 is flagged and escalates. Refund count alone never triggers R8.
- **Partial prior refund → remainder** — cus_15/ord_1016: a $200 in-window order with $80 already
  refunded refunds only the remaining $120 (R9 + R5), never the full price.

## Adversarial data notes

- **Missing order** (cus_14 → `ord_9999`) and any junk id must fail cleanly at lookup (return
  "not found", never crash).
- **Mismatched order** (cus_07 → `ord_1001`) is detectable because `getOrder` returns the order's
  true owner; the eligibility engine compares it to the requesting customer.
