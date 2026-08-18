import { HTTPException } from "hono/http-exception";

/**
 * Database refusals, translated.
 *
 * The schema rejects the expensive mistakes itself, so these errors are a
 * feature: each one is a rule holding. What they are not is presentable --
 * `new row for relation "product_variants" violates check constraint
 * "product_variants_stock_check"` tells a shopper nothing and tells an
 * attacker the table and column names.
 *
 * The copy below is seeded from the table in docs/schema_guide.md, which
 * already wrote these in English. Anything unmapped becomes a 500 with a
 * support code -- never the raw message.
 */

export interface MappedError {
  status: 400 | 403 | 404 | 409 | 422 | 500;
  code: string;
  message: string;
}

/** The shape supabase-js returns in `{ error }` and PostgREST throws. */
export interface DbError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

interface Rule {
  /** Matched against constraint name and message, case-insensitively. */
  match: string;
  status: MappedError["status"];
  code: string;
  message: string;
}

/**
 * Order matters: first match wins, so specific patterns sit above generic
 * ones.
 */
const RULES: Rule[] = [
  // --- stock -------------------------------------------------------------
  {
    match: "product_variants_stock_check",
    status: 409,
    code: "insufficient_stock",
    message: "Not enough stock for one or more items.",
  },
  {
    match: "inv_reservation_expires",
    status: 422,
    code: "reservation_needs_expiry",
    message: "A stock reservation must carry an expiry.",
  },
  {
    match: "uniq_reservation_consumed",
    status: 409,
    code: "reservation_already_consumed",
    message: "That stock reservation has already been released or sold.",
  },

  // --- ledgers and legal documents ---------------------------------------
  {
    match: "is append-only",
    status: 409,
    code: "append_only",
    message:
      "This record is permanent. Add a correcting entry instead of editing it.",
  },
  {
    match: "invoices are immutable",
    status: 409,
    code: "invoice_immutable",
    message: "Invoices cannot be edited. Issue a credit note instead.",
  },
  {
    match: "invoices are permanent",
    status: 409,
    code: "invoice_immutable",
    message: "Invoices cannot be deleted. Issue a credit note instead.",
  },

  // --- money arithmetic ---------------------------------------------------
  {
    match: "orders_totals_balance",
    status: 422,
    code: "totals_do_not_balance",
    message:
      "Order totals do not add up: grand total must equal subtotal minus discount, plus shipping and tax.",
  },
  {
    match: "orders_discount_within_subtotal",
    status: 422,
    code: "discount_exceeds_subtotal",
    message: "The discount cannot be larger than the order subtotal.",
  },

  // --- discounts ----------------------------------------------------------
  {
    match: "discounts_within_max_uses",
    status: 409,
    code: "coupon_exhausted",
    message: "This coupon has been fully redeemed.",
  },
  {
    match: "discounts_percent_range",
    status: 422,
    code: "invalid_discount",
    message: "A percentage discount must be between 0 and 100.",
  },
  {
    match: "discounts_target_matches_scope",
    status: 422,
    code: "invalid_discount",
    message:
      "This discount's scope and target disagree -- pick the product or collection it applies to.",
  },

  // --- gift cards ---------------------------------------------------------
  {
    match: "gift_cards_balance_check",
    status: 409,
    code: "gift_card_overspend",
    message: "That gift card does not have enough balance.",
  },
  {
    match: "balance_after",
    status: 409,
    code: "gift_card_ledger_mismatch",
    message: "Gift card balance does not agree with its transaction history.",
  },

  // --- fulfilment and returns --------------------------------------------
  {
    match: "cannot ship",
    status: 409,
    code: "ships_more_than_ordered",
    message: "Cannot dispatch more of an item than was ordered.",
  },
  {
    match: "cannot return",
    status: 409,
    code: "returns_more_than_ordered",
    message: "Cannot return more of an item than was purchased.",
  },

  // --- catalog integrity --------------------------------------------------
  {
    match: "uniq_variant_combo",
    status: 409,
    code: "duplicate_variant",
    message:
      "Another variant already uses that combination of options. If you are creating one, send all its option values in a single request.",
  },
  {
    match: "uniq_default_variant",
    status: 409,
    code: "default_already_set",
    message: "A product can have only one default variant.",
  },
  {
    match: "uniq_default_address",
    status: 409,
    code: "default_already_set",
    message: "A customer can have only one default address.",
  },
  {
    match: "variant_option_values",
    status: 422,
    code: "cross_product_option",
    message: "That option value belongs to a different product.",
  },
  {
    match: "variants_compare_at_above_price",
    status: 422,
    code: "invalid_price",
    message: "The compare-at price cannot be below the selling price.",
  },
  {
    match: "products_slug_format",
    status: 422,
    code: "invalid_slug",
    message: "Slugs may contain lowercase letters, numbers and hyphens only.",
  },

  // --- identity and contact ----------------------------------------------
  {
    match: "customers_phone_e164",
    status: 422,
    code: "invalid_phone",
    message:
      "Phone numbers must be in international format, e.g. +919876543210.",
  },
  {
    match: "orders_phone_e164",
    status: 422,
    code: "invalid_phone",
    message:
      "Phone numbers must be in international format, e.g. +919876543210.",
  },
  {
    match: "blocklist_value_normalized",
    status: 422,
    code: "invalid_blocklist_value",
    message:
      "Blocklist phone numbers must be international format and pincodes six digits, or the entry matches nothing.",
  },
  {
    match: "addresses_pincode_format",
    status: 422,
    code: "invalid_pincode",
    message: "Enter a valid 6-digit PIN code.",
  },
  {
    match: 'update or delete on table "customers"',
    status: 409,
    code: "customer_not_erasable",
    message:
      "Customers are anonymised, not deleted, so invoices and store credit survive. Use the anonymise action.",
  },

  // --- shipping -----------------------------------------------------------
  {
    match: "rates_no_overlap",
    status: 409,
    code: "overlapping_rate_band",
    message:
      "That shipping rate overlaps an existing band. Exactly one rate must match any basket.",
  },

  // --- invoicing and the admin RPCs -------------------------------------
  //
  // These strings come from our own admin_* functions, which predate the
  // ECOM1/ECOM2 convention and still raise standard SQLSTATEs. Matched by
  // message here rather than re-pasting 400 lines of migration to change
  // five RAISE statements; new functions should use ECOM codes instead.
  {
    match: "already has a tax invoice",
    status: 409,
    code: "already_invoiced",
    message: "This order has already been invoiced. Issue a credit note to correct it.",
  },
  {
    match: "is already stamped",
    status: 409,
    code: "already_stamped",
    message: "That invoice already carries an e-invoice stamp, and the stamp is final.",
  },
  {
    match: "is unpaid",
    status: 409,
    code: "order_unpaid",
    message: "Nothing has been captured for this order yet.",
  },
  {
    match: "seller_gstin is not set",
    status: 409,
    code: "seller_gstin_missing",
    message:
      "The store's GSTIN is not configured, so invoices cannot be issued. Set it in store settings.",
  },
  {
    match: "no place of supply",
    status: 422,
    code: "place_of_supply_missing",
    message:
      "No place of supply, and the store has no state code configured. Send a two-digit GST state code.",
  },
  {
    match: "has no line items",
    status: 409,
    code: "order_empty",
    message: "That order has no line items to invoice.",
  },
  {
    match: "cannot be cancelled",
    status: 409,
    code: "order_not_cancellable",
    message: "This order has gone too far to cancel.",
  },
  {
    match: "not pending",
    status: 409,
    code: "order_not_pending",
    message: "This order is no longer awaiting payment.",
  },
  {
    match: "is already",
    status: 409,
    code: "already_settled",
    message: "That record has already been settled.",
  },

  // --- access -------------------------------------------------------------
  {
    match: "violates row-level security",
    status: 403,
    code: "forbidden",
    message: "You are not allowed to perform that action.",
  },
];

/**
 * A server bug wearing a user error's clothes.
 *
 * customers.id and staff_users.id have no default, deliberately -- they must
 * equal auth.uid(). Hitting this means the API failed to supply it, so it is a
 * 500 for the logs, not a validation message aimed at the caller.
 */
const SERVER_BUGS = [
  'null value in column "id" of relation "customers"',
  'null value in column "id" of relation "staff_users"',
];

export function mapDatabaseError(
  err: DbError | null | undefined,
): MappedError | null {
  if (!err) return null;

  const haystack = [err.message, err.details, err.hint]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (SERVER_BUGS.some((s) => haystack.includes(s.toLowerCase()))) {
    return {
      status: 500,
      code: "identity_not_supplied",
      message: "Something went wrong. Quote the request id to support.",
    };
  }

  // Refusals our own functions raised, with a SQLSTATE Postgres never
  // uses. These messages were written for a customer -- "Coupon DIWALI20
  // is not valid." -- and the SQLSTATE is what proves it: a constraint
  // violation cannot arrive wearing one, so forwarding these does not
  // reopen the door to forwarding Postgres's own words. `hint` carries
  // the machine code so the client can highlight the right field.
  if (err.code === "ECOM1" || err.code === "ECOM2") {
    return {
      status: err.code === "ECOM2" ? 409 : 422,
      code: err.hint ?? "request_refused",
      message: err.message ?? "That request cannot be completed.",
    };
  }

  for (const rule of RULES) {
    if (haystack.includes(rule.match.toLowerCase())) {
      return { status: rule.status, code: rule.code, message: rule.message };
    }
  }

  // PGRST116: ".single() matched no rows".
  if (err.code === "PGRST116") {
    return { status: 404, code: "not_found", message: "Not found." };
  }

  // Last resort before a 500: a handful of SQLSTATEs mean something
  // definite, and answering 500 for them tells a caller to retry
  // something that will never succeed. The message stays generic --
  // unlike an ECOM code, a standard SQLSTATE is no proof we wrote the
  // text, so the database's own words still do not go out.
  const BY_SQLSTATE: Record<string, MappedError> = {
    // no_data_found -- our admin_* functions raise this for "not found"
    P0002: { status: 404, code: "not_found", message: "Not found." },
    // object_not_in_prerequisite_state -- the record is in the wrong state
    "55000": {
      status: 409,
      code: "wrong_state",
      message: "That is not possible in this record's current state.",
    },
    // lock_not_available
    "55006": {
      status: 409,
      code: "in_progress",
      message: "That is still being processed. Try again in a moment.",
    },
    "23505": {
      status: 409,
      code: "already_exists",
      message: "That already exists.",
    },
    "42501": {
      status: 403,
      code: "forbidden",
      message: "You are not allowed to perform that action.",
    },
    "22023": {
      status: 422,
      code: "invalid_parameter",
      message: "One of the values sent is not valid here.",
    },
  };
  if (err.code && BY_SQLSTATE[err.code]) return BY_SQLSTATE[err.code]!;

  return null;
}

/**
 * supabase-js returns errors instead of throwing, which makes them easy to
 * ignore. Call this on every `{ error }` so a refusal cannot be silently
 * dropped and reported as success.
 */
export function throwOnDbError(err: DbError | null | undefined): void {
  if (!err) return;

  const mapped = mapDatabaseError(err);
  if (mapped) {
    throw new HTTPException(mapped.status, {
      message: mapped.message,
      cause: { code: mapped.code, db: err },
    });
  }

  // Unmapped: caller gets a support code, detail goes to the log via
  // app.onError. Returning err.message here would leak table and column names.
  throw new HTTPException(500, {
    message: "Something went wrong. Quote the request id to support.",
    cause: { code: "unmapped_db_error", db: err },
  });
}
