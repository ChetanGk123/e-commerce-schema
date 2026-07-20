/**
 * validation.ts — Zod schemas for every user-facing write path.
 *
 * Completes the trilogy: enums.ts (values) -> database.types.ts
 * (row shapes) -> validation.ts (input rules). Enum-backed fields
 * use the same const arrays, so a status typo cannot compile.
 *
 * Designed for React Hook Form via @hookform/resolvers/zod.
 * Zod v3 syntax (also works on v4).
 *
 * Note on trust: these schemas validate SHAPE on the client and in
 * route handlers. Anything involving money or stock (prices, totals,
 * coupon validity, stock availability) is recomputed server-side
 * from the database — never taken from the request body.
 */

import { z } from 'zod';
import {
  TICKET_CATEGORIES,
  RETURN_REASONS,
  RETURN_RESOLUTIONS,
  DISCOUNT_KINDS,
  DISCOUNT_APPLIES_TO,
} from './enums';

/* ---------- Shared primitives ---------- */

export const uuid = z.string().uuid();

/** Indian PIN code: 6 digits, cannot start with 0. */
export const pincode = z
  .string()
  .regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit PIN code');

/** Indian mobile with optional +91; normalises to bare 10 digits. */
export const phone = z
  .string()
  .regex(/^(\+91[\s-]?)?[6-9]\d{9}$/, 'Enter a valid mobile number')
  .transform((v) => v.replace(/^\+91[\s-]?/, ''));

export const money = z.number().nonnegative().finite();
export const qty = z.number().int().positive();

/* ---------- Address ---------- */

export const addressSchema = z.object({
  label: z.string().max(30).optional(),
  line1: z.string().min(3, 'Address is required').max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(2).max(80),
  state: z.string().min(2).max(80),
  postal_code: pincode,
  country: z.string().length(2).default('IN'),
});
export type AddressInput = z.infer<typeof addressSchema>;

/* ---------- Checkout ---------- */

export const checkoutSchema = z.object({
  items: z
    .array(z.object({ variant_id: uuid, quantity: qty.max(99) }))
    .min(1, 'Your cart is empty')
    .max(50),
  shipping_address: addressSchema,
  contact_phone: phone,
  payment_method: z.enum(['razorpay', 'cod']),
  coupon_code: z
    .string()
    .max(30)
    .transform((s) => s.trim().toUpperCase())
    .optional(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

/* ---------- Reviews ---------- */

export const reviewSchema = z.object({
  product_id: uuid,
  order_item_id: uuid.optional(), // present => "Verified buyer"
  rating: z.number().int().min(1).max(5),
  title: z.string().max(120).optional(),
  body: z.string().max(2000).optional(),
});
export type ReviewInput = z.infer<typeof reviewSchema>;

/* ---------- Returns ---------- */

export const returnRequestSchema = z.object({
  order_id: uuid,
  reason: z.enum(RETURN_REASONS),
  note: z.string().max(1000).optional(),
  preferred_resolution: z.enum(RETURN_RESOLUTIONS).optional(),
  items: z
    .array(z.object({ order_item_id: uuid, quantity: qty }))
    .min(1, 'Select at least one item to return'),
});
export type ReturnRequestInput = z.infer<typeof returnRequestSchema>;

/* ---------- Support tickets ---------- */

export const ticketSchema = z.object({
  category: z.enum(TICKET_CATEGORIES),
  subject: z.string().min(3, 'Subject is too short').max(150),
  message: z.string().min(10, 'Tell us a bit more').max(5000),
  order_id: uuid.optional(),
});
export type TicketInput = z.infer<typeof ticketSchema>;

export const ticketReplySchema = z.object({
  body: z.string().min(1, 'Message cannot be empty').max(5000),
});
export type TicketReplyInput = z.infer<typeof ticketReplySchema>;

/** Guest contact form (server turns it into a ticket). */
export const contactSchema = z
  .object({
    name: z.string().min(2).max(80),
    email: z.string().email().optional(),
    phone: phone.optional(),
    message: z.string().min(10, 'Tell us a bit more').max(2000),
  })
  .refine((d) => !!d.email || !!d.phone, {
    message: 'Provide an email or a phone number',
    path: ['email'],
  });
export type ContactInput = z.infer<typeof contactSchema>;

/* ---------- Product enquiries ---------- */

// Guest contact fields are optional here; the server requires
// email-or-phone when there is no logged-in customer.
export const enquirySchema = z.object({
  product_id: uuid.optional(),
  variant_id: uuid.optional(),
  quantity: qty.optional(), // bulk interest
  message: z.string().min(10, 'Tell us a bit more').max(2000),
  guest_name: z.string().min(2).max(80).optional(),
  guest_email: z.string().email().optional(),
  guest_phone: phone.optional(),
});
export type EnquiryInput = z.infer<typeof enquirySchema>;

/* ---------- Stock alerts ---------- */

// Logged-in users subscribe with their account; guests with email
// (the server decides which, based on the session).
export const stockAlertSchema = z.object({
  variant_id: uuid,
  email: z.string().email().optional(),
});
export type StockAlertInput = z.infer<typeof stockAlertSchema>;

/* ---------- Profile & preferences ---------- */

export const profileSchema = z.object({
  full_name: z.string().min(2).max(100),
  phone: phone.optional(),
});
export type ProfileInput = z.infer<typeof profileSchema>;

export const communicationPreferencesSchema = z.object({
  order_updates_email: z.boolean(),
  order_updates_sms: z.boolean(),
  order_updates_whatsapp: z.boolean(),
  marketing_email: z.boolean(),
  marketing_sms: z.boolean(),
  marketing_whatsapp: z.boolean(),
});
export type CommunicationPreferencesInput = z.infer<
  typeof communicationPreferencesSchema
>;

/* ---------- Admin forms ---------- */

export const slug = z
  .string()
  .min(2)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, numbers and hyphens only');

export const productAdminSchema = z.object({
  name: z.string().min(2).max(200),
  slug,
  brand: z.string().max(80).optional(),
  category_id: uuid.optional(),
  description: z.string().max(5000).optional(),
  hsn_code: z.string().regex(/^\d{4,8}$/, '4-8 digit HSN code').optional(),
  gst_rate: z.number().min(0).max(28).optional(),
});
export type ProductAdminInput = z.infer<typeof productAdminSchema>;

// Note: no `stock` field on purpose — stock only changes through
// inventory movements (the ledger), never by editing the variant.
export const variantAdminSchema = z
  .object({
    sku: z
      .string()
      .min(2)
      .max(40)
      .regex(/^[A-Za-z0-9._/-]+$/, 'Letters, numbers, . _ / - only'),
    title: z.string().max(150).optional(),
    description: z.string().max(5000).optional(),
    price: money,
    compare_at_price: money.optional(),
    cost_price: money.optional(),
    weight_grams: z.number().int().positive().optional(),
    barcode: z.string().max(64).optional(),
    is_default: z.boolean().optional(),
  })
  .refine(
    (v) => v.compare_at_price === undefined || v.compare_at_price >= v.price,
    {
      message: 'MRP should not be below the selling price',
      path: ['compare_at_price'],
    },
  );
export type VariantAdminInput = z.infer<typeof variantAdminSchema>;

export const discountAdminSchema = z
  .object({
    code: z
      .string()
      .min(3)
      .max(30)
      .transform((s) => s.trim().toUpperCase()),
    description: z.string().max(200).optional(),
    kind: z.enum(DISCOUNT_KINDS),
    value: money,
    applies_to: z.enum(DISCOUNT_APPLIES_TO).default('order'),
    collection_id: uuid.optional(),
    product_id: uuid.optional(),
    min_order_total: money.optional(),
    max_uses: z.number().int().positive().optional(),
    max_uses_per_customer: z.number().int().positive().optional(),
    starts_at: z.coerce.date().optional(),
    ends_at: z.coerce.date().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.kind === 'percent' && d.value > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'Percentage cannot exceed 100',
      });
    }
    if (d.kind === 'free_shipping' && d.value !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'Free shipping discounts should have value 0',
      });
    }
    if (d.applies_to === 'collection' && !d.collection_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collection_id'],
        message: 'Pick the collection this applies to',
      });
    }
    if (d.applies_to === 'product' && !d.product_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['product_id'],
        message: 'Pick the product this applies to',
      });
    }
    if (d.starts_at && d.ends_at && d.ends_at <= d.starts_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ends_at'],
        message: 'End date must be after the start date',
      });
    }
  });
export type DiscountAdminInput = z.infer<typeof discountAdminSchema>;