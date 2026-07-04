import { z } from "zod";
import { findCustomerByEmail, getCustomer } from "@/lib/db";
import { defineTool } from "@/lib/tools/types";

const inputSchema = z
  .object({
    customerId: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
  })
  .refine((i) => Boolean(i.customerId || i.email), {
    message: "Provide either customerId or email.",
  });
type Input = z.infer<typeof inputSchema>;

const orderSummarySchema = z.object({
  id: z.string(),
  price: z.number(),
  status: z.string(),
  purchaseDate: z.string(),
  deliveryDate: z.string().nullable(),
  itemCount: z.number(),
  alreadyRefunded: z.boolean(),
});

const outputSchema = z.object({
  found: z.boolean(),
  customer: z
    .object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      abuseFlag: z.boolean(),
      refundsLast90Days: z.number(),
      orders: z.array(orderSummarySchema),
    })
    .optional(),
});
type Output = z.infer<typeof outputSchema>;

export const lookupCustomerTool = defineTool<Input, Output>({
  name: "lookup_customer",
  description:
    "Look up a customer by id or email. Returns their identity, abuse flag, recent-refund count, and a summary of their orders. Returns found:false for unknown customers.",
  inputSchema,
  outputSchema,
  run: (ctx, input) => {
    const customer = input.customerId
      ? getCustomer(ctx.sessionId, input.customerId)
      : input.email
        ? findCustomerByEmail(ctx.sessionId, input.email)
        : undefined;
    if (!customer) return { found: false };
    return {
      found: true,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        abuseFlag: customer.abuseFlag,
        refundsLast90Days: customer.refundsLast90Days,
        orders: customer.orders.map((o) => ({
          id: o.id,
          price: o.price,
          status: o.status,
          purchaseDate: o.purchaseDate,
          deliveryDate: o.deliveryDate,
          itemCount: o.items.length,
          alreadyRefunded: o.priorRefund.refunded,
        })),
      },
    };
  },
});
