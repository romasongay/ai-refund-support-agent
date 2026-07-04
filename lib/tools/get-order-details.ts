import { z } from "zod";
import { getOrder } from "@/lib/db";
import { defineTool } from "@/lib/tools/types";

const inputSchema = z.object({
  orderId: z.string().min(1),
  customerId: z.string().min(1).optional(),
});
type Input = z.infer<typeof inputSchema>;

const itemSchema = z.object({
  name: z.string(),
  category: z.string(),
  price: z.number(),
  finalSale: z.boolean(),
  digital: z.boolean(),
  condition: z.string(),
});

const outputSchema = z.object({
  found: z.boolean(),
  order: z
    .object({
      id: z.string(),
      items: z.array(itemSchema),
      price: z.number(),
      purchaseDate: z.string(),
      deliveryDate: z.string().nullable(),
      status: z.string(),
      paymentMethod: z.string(),
      priorRefund: z.object({ refunded: z.boolean(), amount: z.number() }),
    })
    .optional(),
  ownerCustomerId: z.string().optional(),
  ownedByRequestingCustomer: z.boolean().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const getOrderDetailsTool = defineTool<Input, Output>({
  name: "get_order_details",
  description:
    "Fetch full details of an order by id: its items (with final-sale, digital, and condition flags), total price, purchase and delivery dates, status, payment method, and prior-refund state. Also reports the order's true owner so identity can be verified. Returns found:false for unknown orders.",
  inputSchema,
  outputSchema,
  run: (ctx, input) => {
    const found = getOrder(ctx.sessionId, input.orderId);
    if (!found) return { found: false };
    const { customer, order } = found;
    return {
      found: true,
      order: {
        id: order.id,
        items: order.items,
        price: order.price,
        purchaseDate: order.purchaseDate,
        deliveryDate: order.deliveryDate,
        status: order.status,
        paymentMethod: order.paymentMethod,
        priorRefund: order.priorRefund,
      },
      ownerCustomerId: customer.id,
      ownedByRequestingCustomer: input.customerId ? customer.id === input.customerId : undefined,
    };
  },
});
