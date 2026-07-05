/**
 * Typed data-access module for the mock CRM.
 *
 * Design (per §1 locked decisions + HARVEST notes):
 * - The on-disk fixture (`data/customers.json`) stores dates as **relative offsets**
 *   (`purchasedDaysAgo`, `deliveredDaysAgo`), never absolute calendar dates, so refund windows
 *   never silently expire. Concrete ISO dates are **materialized against an injectable clock**.
 * - All fixture data is validated with Zod at load time; malformed data fails fast and loudly.
 * - Mutations happen in an **in-memory, per-session store** — deterministic, resettable, and
 *   isolated between sessions. Each session freezes its own "now" so its dates are stable.
 * - Every lookup is junk-id safe: unknown ids return `undefined`, never throw.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import rawCustomers from "@/data/customers.json";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ITEM_CONDITIONS = ["new", "opened", "damaged", "defective"] as const;
export const ORDER_STATUSES = ["delivered", "in_transit", "processing", "cancelled"] as const;
export const PAYMENT_METHODS = [
  "visa",
  "mastercard",
  "amex",
  "paypal",
  "gift_card",
  "apple_pay",
] as const;

export type ItemCondition = (typeof ITEM_CONDITIONS)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// ---------------------------------------------------------------------------
// Fixture schemas (raw, with relative date offsets)
// ---------------------------------------------------------------------------

export const MONEY_EPSILON = 0.005;

export const OrderItemSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  price: z.number().min(0),
  finalSale: z.boolean(),
  digital: z.boolean(),
  condition: z.enum(ITEM_CONDITIONS),
});

export const PriorRefundSchema = z.object({
  refunded: z.boolean(),
  amount: z.number().min(0), // >= 0 (HARVEST ERR-001: 0 is legitimate), not .positive()
});

export const OrderFixtureSchema = z
  .object({
    id: z.string().min(1),
    items: z.array(OrderItemSchema).min(1),
    price: z.number().min(0),
    purchasedDaysAgo: z.number().int().min(0),
    deliveredDaysAgo: z.number().int().min(0).nullable(),
    status: z.enum(ORDER_STATUSES),
    paymentMethod: z.enum(PAYMENT_METHODS),
    priorRefund: PriorRefundSchema,
  })
  .refine(
    (o) => Math.abs(o.price - o.items.reduce((sum, it) => sum + it.price, 0)) < MONEY_EPSILON,
    { message: "order.price must equal the sum of its item prices", path: ["price"] },
  )
  .refine((o) => o.deliveredDaysAgo === null || o.deliveredDaysAgo <= o.purchasedDaysAgo, {
    message: "deliveredDaysAgo must be <= purchasedDaysAgo (delivery happens after purchase)",
    path: ["deliveredDaysAgo"],
  })
  .refine((o) => o.priorRefund.amount <= o.price + MONEY_EPSILON, {
    message: "priorRefund.amount cannot exceed the order price",
    path: ["priorRefund", "amount"],
  })
  // The `refunded` flag must be a faithful cache of (amount > 0 && amount >= price): the flag and the
  // amount can never disagree, so the engine can trust either. Malformed rows fail fast at load.
  .refine(
    (o) =>
      o.priorRefund.refunded ===
      (o.priorRefund.amount > 0 && o.priorRefund.amount >= o.price - MONEY_EPSILON),
    {
      message: "priorRefund.refunded must equal (amount > 0 && amount >= price)",
      path: ["priorRefund", "refunded"],
    },
  );

export const CustomerFixtureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.email(),
  abuseFlag: z.boolean(),
  refundsLast90Days: z.number().int().min(0),
  orders: z.array(OrderFixtureSchema),
});

export const CustomersFixtureSchema = z
  .array(CustomerFixtureSchema)
  .refine((list) => new Set(list.map((c) => c.id)).size === list.length, {
    message: "customer ids must be unique",
  });

export type OrderItem = z.infer<typeof OrderItemSchema>;
export type OrderFixture = z.infer<typeof OrderFixtureSchema>;
export type CustomerFixture = z.infer<typeof CustomerFixtureSchema>;

// ---------------------------------------------------------------------------
// Runtime (materialized) types — concrete ISO dates instead of offsets
// ---------------------------------------------------------------------------

export interface Order {
  id: string;
  items: OrderItem[];
  price: number;
  /** ISO timestamp, computed as `now - purchasedDaysAgo`. */
  purchaseDate: string;
  /** ISO timestamp, computed as `now - deliveredDaysAgo`, or null if not delivered. */
  deliveryDate: string | null;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  priorRefund: { refunded: boolean; amount: number };
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  abuseFlag: boolean;
  refundsLast90Days: number;
  orders: Order[];
}

// ---------------------------------------------------------------------------
// Fixture loading + materialization
// ---------------------------------------------------------------------------

let cachedFixture: CustomerFixture[] | null = null;

/** Parse + validate the raw fixture once; throws a clear error if the data is malformed. */
export function getValidatedFixture(): CustomerFixture[] {
  if (cachedFixture) return cachedFixture;
  const parsed = CustomersFixtureSchema.safeParse(rawCustomers);
  if (!parsed.success) {
    throw new Error(`Invalid customers.json fixture:\n${z.prettifyError(parsed.error)}`);
  }
  cachedFixture = parsed.data;
  return cachedFixture;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

function materializeOrder(fixture: OrderFixture, now: Date): Order {
  return {
    id: fixture.id,
    items: fixture.items.map((it) => ({ ...it })),
    price: fixture.price,
    purchaseDate: isoDaysAgo(now, fixture.purchasedDaysAgo),
    deliveryDate:
      fixture.deliveredDaysAgo === null ? null : isoDaysAgo(now, fixture.deliveredDaysAgo),
    status: fixture.status,
    paymentMethod: fixture.paymentMethod,
    priorRefund: { ...fixture.priorRefund },
  };
}

/**
 * Build a fresh, deep-cloned dataset with dates materialized relative to `now`.
 * Read-only convenience (e.g. for a profile selector); not attached to any session.
 */
export function getPristineCustomers(now: Date = new Date()): Customer[] {
  return getValidatedFixture().map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    abuseFlag: c.abuseFlag,
    refundsLast90Days: c.refundsLast90Days,
    orders: c.orders.map((o) => materializeOrder(o, now)),
  }));
}

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface Session {
  id: string;
  createdAt: number;
  /** Frozen clock for this session so its materialized dates stay stable across calls. */
  now: Date;
  boundCustomerId?: string;
  customers: Customer[];
}

const sessions = new Map<string, Session>();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Create a session with its own fresh, mutable copy of the dataset. If `boundCustomerId` is
 * provided it must exist in the dataset. Returns the created session.
 */
export function createSession(
  opts: { sessionId?: string; boundCustomerId?: string; now?: Date } = {},
): Session {
  const now = opts.now ?? new Date();
  const id = opts.sessionId?.trim() || `sess_${randomUUID()}`;
  const customers = getPristineCustomers(now);
  if (opts.boundCustomerId && !customers.some((c) => c.id === opts.boundCustomerId)) {
    throw new Error(`Cannot bind session to unknown customer id: ${opts.boundCustomerId}`);
  }
  const session: Session = {
    id,
    createdAt: now.getTime(),
    now,
    boundCustomerId: opts.boundCustomerId,
    customers,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** Restore a session's data to pristine (dates keep the session's frozen clock). */
export function resetSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.customers = getPristineCustomers(session.now);
  return true;
}

export function deleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

/** Clear every session (used by the global reset endpoint / tests). */
export function resetAllSessions(): void {
  sessions.clear();
}

export function sessionCount(): number {
  return sessions.size;
}

/** Remove sessions older than `ttlMs`. Returns the number removed. */
export function cleanupExpiredSessions(
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
  nowMs: number = Date.now(),
): number {
  let removed = 0;
  for (const [id, session] of sessions) {
    if (nowMs - session.createdAt > ttlMs) {
      sessions.delete(id);
      removed += 1;
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Session-scoped lookups (all junk-id safe: unknown ids return undefined)
// ---------------------------------------------------------------------------

export function listCustomers(sessionId: string): Customer[] {
  return sessions.get(sessionId)?.customers ?? [];
}

/**
 * Resolve a loosely-typed / SPOKEN identifier to a stored id. Voice transcription drops underscores,
 * changes case, and adds words/punctuation ("ord_1001" → "ORD1001", "order 1001", "1,001", "#1001"),
 * so exact-string matching fails on speech input. We match, in order: (1) exact, (2) case- and
 * separator-insensitive, (3) the bare numeric part. Each step resolves ONLY when it matches exactly
 * one candidate — an ambiguous match returns `undefined` rather than guessing, so this can never
 * mis-route a refund. Ownership (R6) is enforced separately, on the resolved ids.
 */
const canonId = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const numKey = (s: string): string | null => {
  const digits = s.replace(/\D/g, "");
  return digits ? String(Number.parseInt(digits, 10)) : null;
};

export function resolveId(query: string, candidates: readonly string[]): string | undefined {
  if (typeof query !== "string") return undefined;
  const q = query.trim();
  if (!q) return undefined;
  if (candidates.includes(q)) return q; // 1) exact (fast path — never ambiguous)

  const qc = canonId(q); // 2) case + separators: "ORD1001", "ord-1001"
  if (qc) {
    const byCanon = candidates.filter((c) => canonId(c) === qc);
    if (byCanon.length === 1) return byCanon[0];
  }

  const qn = numKey(q); // 3) bare numeric part: "1001", "order 1001", "1,001", "#1001"
  if (qn !== null) {
    const byNum = candidates.filter((c) => numKey(c) === qn);
    if (byNum.length === 1) return byNum[0];
  }
  return undefined;
}

export function getCustomer(sessionId: string, customerId: string): Customer | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  const resolved = resolveId(
    customerId,
    session.customers.map((c) => c.id),
  );
  return resolved ? session.customers.find((c) => c.id === resolved) : undefined;
}

export function findCustomerByEmail(sessionId: string, email: string): Customer | undefined {
  const session = sessions.get(sessionId);
  if (!session || typeof email !== "string") return undefined;
  const target = normalizeEmail(email);
  return session.customers.find((c) => normalizeEmail(c.email) === target);
}

/** Look up an order across all customers in the session, returning it with its owner. */
export function getOrder(
  sessionId: string,
  orderId: string,
): { customer: Customer; order: Order } | undefined {
  const session = sessions.get(sessionId);
  if (!session || typeof orderId !== "string") return undefined;
  // Resolve a spoken/loose order id against every order id in the session (unique-match only).
  const resolved = resolveId(
    orderId,
    session.customers.flatMap((c) => c.orders.map((o) => o.id)),
  );
  if (!resolved) return undefined;
  for (const customer of session.customers) {
    const order = customer.orders.find((o) => o.id === resolved);
    if (order) return { customer, order };
  }
  return undefined;
}

/** Resolve a spoken/loose order id to its canonical stored id for this session (or undefined). */
export function resolveOrderId(sessionId: string, orderId: string): string | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  return resolveId(
    orderId,
    session.customers.flatMap((c) => c.orders.map((o) => o.id)),
  );
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type RefundMutationResult =
  | { ok: true; order: Order; totalRefunded: number }
  | { ok: false; reason: "session_not_found" | "order_not_found" | "invalid_amount" };

/**
 * Record a refund of `amount` against an order (in-memory, session-scoped). Accumulates onto any
 * prior refund and marks the order fully refunded once the cumulative amount reaches its price.
 * This is a mechanical record; policy gating (R5/R9) lives in the tools layer.
 */
export function markOrderRefunded(
  sessionId: string,
  orderId: string,
  amount: number,
): RefundMutationResult {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, reason: "session_not_found" };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid_amount" };
  const found = getOrder(sessionId, orderId);
  if (!found) return { ok: false, reason: "order_not_found" };
  const { order } = found;
  const totalRefunded = order.priorRefund.amount + amount;
  order.priorRefund = {
    amount: totalRefunded,
    refunded: totalRefunded >= order.price - MONEY_EPSILON,
  };
  return { ok: true, order, totalRefunded };
}
