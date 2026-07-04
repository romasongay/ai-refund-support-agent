import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupExpiredSessions,
  createSession,
  deleteSession,
  findCustomerByEmail,
  getCustomer,
  getOrder,
  getPristineCustomers,
  getValidatedFixture,
  listCustomers,
  markOrderRefunded,
  OrderFixtureSchema,
  resetAllSessions,
  resetSession,
  sessionCount,
} from "@/lib/db";

afterEach(() => resetAllSessions());

const daysSince = (now: Date, iso: string) =>
  Math.round((now.getTime() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));

describe("fixture integrity", () => {
  it("validates and contains exactly 15 profiles with unique ids", () => {
    const fx = getValidatedFixture();
    expect(fx).toHaveLength(15);
    expect(new Set(fx.map((c) => c.id)).size).toBe(15);
  });

  it("every order price equals the sum of its item prices (enforced by schema)", () => {
    for (const c of getValidatedFixture()) {
      for (const o of c.orders) {
        const sum = o.items.reduce((s, i) => s + i.price, 0);
        expect(Math.abs(o.price - sum)).toBeLessThan(0.005);
      }
    }
  });

  it("emails are unique and well-formed", () => {
    const emails = getValidatedFixture().map((c) => c.email.toLowerCase());
    expect(new Set(emails).size).toBe(emails.length);
    for (const e of emails) expect(e).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  });

  it("rejects a prior-refund flag that disagrees with the amount (cross-field refine)", () => {
    const baseOrder = {
      id: "ord_test",
      items: [
        {
          name: "Thing",
          category: "misc",
          price: 100,
          finalSale: false,
          digital: false,
          condition: "new",
        },
      ],
      price: 100,
      purchasedDaysAgo: 5,
      deliveredDaysAgo: 3,
      status: "delivered",
      paymentMethod: "visa",
    };
    // refunded=true but amount=0 → inconsistent → rejected.
    expect(
      OrderFixtureSchema.safeParse({ ...baseOrder, priorRefund: { refunded: true, amount: 0 } })
        .success,
    ).toBe(false);
    // refunded=false but amount=full price → inconsistent → rejected.
    expect(
      OrderFixtureSchema.safeParse({ ...baseOrder, priorRefund: { refunded: false, amount: 100 } })
        .success,
    ).toBe(false);
    // Consistent pairs pass.
    expect(
      OrderFixtureSchema.safeParse({ ...baseOrder, priorRefund: { refunded: true, amount: 100 } })
        .success,
    ).toBe(true);
    expect(
      OrderFixtureSchema.safeParse({ ...baseOrder, priorRefund: { refunded: false, amount: 40 } })
        .success,
    ).toBe(true);
  });
});

describe("edge-case coverage (every policy clause exercised by the data)", () => {
  const fx = getValidatedFixture();
  const orders = fx.flatMap((c) => c.orders);
  const items = orders.flatMap((o) => o.items);

  it("R2 — has a final-sale item", () => expect(items.some((i) => i.finalSale)).toBe(true));
  it("R3 — has a digital good", () => expect(items.some((i) => i.digital)).toBe(true));
  it("R4 — has an order over $500", () => expect(orders.some((o) => o.price > 500)).toBe(true));
  it("R5 — has an already-refunded order", () =>
    expect(orders.some((o) => o.priorRefund.refunded)).toBe(true));
  it("R7 — has damaged and defective items", () => {
    expect(items.some((i) => i.condition === "damaged")).toBe(true);
    expect(items.some((i) => i.condition === "defective")).toBe(true);
  });
  it("R8 — has an abuse-flagged customer", () => expect(fx.some((c) => c.abuseFlag)).toBe(true));
  it("R1 — has both within-window and outside-window deliveries", () => {
    expect(orders.some((o) => o.deliveredDaysAgo !== null && o.deliveredDaysAgo <= 30)).toBe(true);
    expect(orders.some((o) => o.deliveredDaysAgo !== null && o.deliveredDaysAgo > 30)).toBe(true);
  });
  it("R9 — has a multi-item order mixing an eligible item with a final-sale item", () => {
    expect(
      orders.some(
        (o) =>
          o.items.length > 1 &&
          o.items.some((i) => i.finalSale) &&
          o.items.some((i) => !i.finalSale && !i.digital),
      ),
    ).toBe(true);
  });

  it("R5/R9 — has a partial-prior-refund order (remainder still owed)", () =>
    expect(
      orders.some(
        (o) =>
          !o.priorRefund.refunded && o.priorRefund.amount > 0 && o.priorRefund.amount < o.price,
      ),
    ).toBe(true));
});

describe("dates are runtime-relative (never expire)", () => {
  it("materializes delivery dates as offsets from the session clock", () => {
    const now = new Date("2027-04-01T00:00:00.000Z");
    const s = createSession({ now });
    const { order } = getOrder(s.id, "ord_1001")!;
    // ord_1001 is delivered 10 days ago in the fixture.
    expect(daysSince(now, order.deliveryDate!)).toBe(10);
    expect(new Date(order.purchaseDate).getTime()).toBeLessThan(
      new Date(order.deliveryDate!).getTime(),
    );
  });

  it("window classification is invariant to the run date (relative, not hardcoded)", () => {
    const now1 = new Date("2027-03-15T12:00:00.000Z");
    const now2 = new Date("2029-11-20T06:00:00.000Z");
    const a = createSession({ now: now1 });
    const b = createSession({ now: now2 });

    const inA = getOrder(a.id, "ord_1001")!.order; // delivered 10d ago
    const inB = getOrder(b.id, "ord_1001")!.order;
    const outA = getOrder(a.id, "ord_1002")!.order; // delivered 60d ago
    const outB = getOrder(b.id, "ord_1002")!.order;

    // Concrete dates differ between runs...
    expect(inA.deliveryDate).not.toBe(inB.deliveryDate);
    // ...but "days since delivery" and the 30-day classification are identical.
    expect(daysSince(now1, inA.deliveryDate!)).toBe(10);
    expect(daysSince(now2, inB.deliveryDate!)).toBe(10);
    expect(daysSince(now1, outA.deliveryDate!)).toBe(60);
    expect(daysSince(now2, outB.deliveryDate!)).toBe(60);
  });

  it("getPristineCustomers uses the provided clock", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const [first] = getPristineCustomers(now);
    expect(daysSince(now, first.orders[0].deliveryDate!)).toBe(10);
  });
});

describe("lookups are junk-id safe", () => {
  it("finds customers by id and by (case-insensitive) email", () => {
    const s = createSession();
    expect(getCustomer(s.id, "cus_01")?.name).toBe("Avery Stone");
    expect(findCustomerByEmail(s.id, "  AVERY.STONE@Example.com ")?.id).toBe("cus_01");
    expect(listCustomers(s.id)).toHaveLength(15);
  });

  it("returns the true owner from getOrder (enables the R6 ownership check)", () => {
    const s = createSession();
    const found = getOrder(s.id, "ord_1001");
    expect(found?.customer.id).toBe("cus_01");
    expect(found?.order.id).toBe("ord_1001");
  });

  it("returns undefined for unknown ids instead of throwing", () => {
    const s = createSession();
    expect(getCustomer(s.id, "cus_ZZZ")).toBeUndefined();
    expect(getCustomer(s.id, "")).toBeUndefined();
    expect(findCustomerByEmail(s.id, "nobody@example.com")).toBeUndefined();
    expect(getOrder(s.id, "ord_9999")).toBeUndefined();
    expect(getOrder(s.id, "'; DROP TABLE orders; --")).toBeUndefined();
    // unknown session
    expect(getCustomer("sess_nope", "cus_01")).toBeUndefined();
    expect(listCustomers("sess_nope")).toEqual([]);
  });
});

describe("session store", () => {
  it("isolates mutations between sessions and resets to pristine", () => {
    const a = createSession();
    const b = createSession();
    expect(a.id).not.toBe(b.id);

    const res = markOrderRefunded(a.id, "ord_1001", 129);
    expect(res.ok).toBe(true);
    expect(getOrder(a.id, "ord_1001")!.order.priorRefund.refunded).toBe(true);
    // Session B is untouched.
    expect(getOrder(b.id, "ord_1001")!.order.priorRefund.refunded).toBe(false);

    // Reset restores session A.
    expect(resetSession(a.id)).toBe(true);
    expect(getOrder(a.id, "ord_1001")!.order.priorRefund.refunded).toBe(false);
  });

  it("rejects binding to an unknown customer", () => {
    expect(() => createSession({ boundCustomerId: "cus_ZZZ" })).toThrow(/unknown customer/i);
    const ok = createSession({ boundCustomerId: "cus_02" });
    expect(ok.boundCustomerId).toBe("cus_02");
  });

  it("supports delete and TTL cleanup", () => {
    resetAllSessions();
    const s = createSession({ now: new Date("2027-01-01T00:00:00.000Z") });
    expect(sessionCount()).toBe(1);
    // Not yet expired 1 minute later.
    expect(cleanupExpiredSessions(60_000, s.createdAt + 30_000)).toBe(0);
    // Expired well past the TTL.
    expect(cleanupExpiredSessions(60_000, s.createdAt + 120_000)).toBe(1);
    expect(sessionCount()).toBe(0);

    const s2 = createSession();
    expect(deleteSession(s2.id)).toBe(true);
    expect(deleteSession(s2.id)).toBe(false);
  });
});

describe("markOrderRefunded", () => {
  it("accumulates partial refunds and flags full refunds", () => {
    const s = createSession();
    // ord_1011 total is $90.
    const first = markOrderRefunded(s.id, "ord_1011", 70);
    expect(first).toMatchObject({ ok: true, totalRefunded: 70 });
    expect(getOrder(s.id, "ord_1011")!.order.priorRefund.refunded).toBe(false);

    const second = markOrderRefunded(s.id, "ord_1011", 20);
    expect(second).toMatchObject({ ok: true, totalRefunded: 90 });
    expect(getOrder(s.id, "ord_1011")!.order.priorRefund.refunded).toBe(true);
  });

  it("fails cleanly on bad inputs", () => {
    const s = createSession();
    expect(markOrderRefunded(s.id, "ord_9999", 10)).toEqual({
      ok: false,
      reason: "order_not_found",
    });
    expect(markOrderRefunded(s.id, "ord_1001", 0)).toEqual({ ok: false, reason: "invalid_amount" });
    expect(markOrderRefunded(s.id, "ord_1001", -5)).toEqual({
      ok: false,
      reason: "invalid_amount",
    });
    expect(markOrderRefunded(s.id, "ord_1001", NaN)).toEqual({
      ok: false,
      reason: "invalid_amount",
    });
    expect(markOrderRefunded("sess_nope", "ord_1001", 10)).toEqual({
      ok: false,
      reason: "session_not_found",
    });
  });
});
