import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { requireAuth, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { jsonError, pageQuery, validationHook } from "../schemas";

/**
 * GST invoicing.
 *
 * An invoice is the one document here a government reads, and the three
 * facts everything below works around are that it cannot be edited, it
 * cannot be deleted, and its number cannot skip.
 *
 * So there is no PATCH. A mistake is corrected by a credit note -- a
 * second document, positively valued, pointing at the first -- and the
 * database refuses anything else, including from the service key,
 * because protect_invoice() is a trigger rather than a policy.
 */
const InvoiceLine = z
  .object({
    id: z.string().uuid(),
    description: z.string(),
    hsnCode: z.string().nullable(),
    quantity: z.number().int(),
    unitPrice: z.number(),
    taxableValue: z.number(),
    gstRate: z.number(),
    cgstAmount: z.number(),
    sgstAmount: z.number(),
    igstAmount: z.number(),
    lineTotal: z.number(),
  })
  .openapi("InvoiceLine");

const Invoice = z
  .object({
    id: z.string().uuid(),
    invoiceNumber: z.string(),
    orderId: z.string().uuid(),
    orderNumber: z.string().nullable(),
    kind: z.enum(["tax_invoice", "credit_note"]),
    parentInvoiceId: z.string().uuid().nullable(),
    customerName: z.string(),
    customerGstin: z.string().nullable(),
    sellerGstin: z.string(),
    placeOfSupply: z.string(),
    taxableValue: z.number(),
    cgstTotal: z.number(),
    sgstTotal: z.number(),
    igstTotal: z.number(),
    grandTotal: z.number(),
    /** Null until the IRP answers. Once set, the whole stamp is final. */
    irn: z.string().nullable(),
    ackNo: z.string().nullable(),
    ackDate: z.string().nullable(),
    issuedAt: z.string(),
    lines: z.array(InvoiceLine),
  })
  .openapi("Invoice");

interface InvoiceRow {
  id: string;
  invoice_number: string;
  order_id: string;
  kind: "tax_invoice" | "credit_note";
  parent_invoice_id: string | null;
  customer_name: string;
  customer_gstin: string | null;
  seller_gstin: string;
  place_of_supply: string;
  taxable_value: number;
  cgst_total: number;
  sgst_total: number;
  igst_total: number;
  grand_total: number;
  irn: string | null;
  ack_no: string | null;
  ack_date: string | null;
  issued_at: string;
  orders: { order_number: string } | null;
  invoice_lines: {
    id: string;
    description: string;
    hsn_code: string | null;
    quantity: number;
    unit_price: number;
    taxable_value: number;
    gst_rate: number;
    cgst_amount: number;
    sgst_amount: number;
    igst_amount: number;
    line_total: number;
  }[];
}

// signed_qr is deliberately absent: it is a long opaque blob that
// belongs on a printed invoice, not in every list response.
const INVOICE_SELECT =
  "id, invoice_number, order_id, kind, parent_invoice_id, customer_name, customer_gstin, seller_gstin, place_of_supply, taxable_value, cgst_total, sgst_total, igst_total, grand_total, irn, ack_no, ack_date, issued_at, orders!inner(order_number), invoice_lines(id, description, hsn_code, quantity, unit_price, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total)";

const n = (v: number) => Number(v);

const shape = (i: InvoiceRow) => ({
  id: i.id,
  invoiceNumber: i.invoice_number,
  orderId: i.order_id,
  orderNumber: i.orders?.order_number ?? null,
  kind: i.kind,
  parentInvoiceId: i.parent_invoice_id,
  customerName: i.customer_name,
  customerGstin: i.customer_gstin,
  sellerGstin: i.seller_gstin,
  placeOfSupply: i.place_of_supply,
  taxableValue: n(i.taxable_value),
  cgstTotal: n(i.cgst_total),
  sgstTotal: n(i.sgst_total),
  igstTotal: n(i.igst_total),
  grandTotal: n(i.grand_total),
  irn: i.irn,
  ackNo: i.ack_no,
  ackDate: i.ack_date,
  issuedAt: i.issued_at,
  lines: (i.invoice_lines ?? []).map((l) => ({
    id: l.id,
    description: l.description,
    hsnCode: l.hsn_code,
    quantity: l.quantity,
    unitPrice: n(l.unit_price),
    taxableValue: n(l.taxable_value),
    gstRate: n(l.gst_rate),
    cgstAmount: n(l.cgst_amount),
    sgstAmount: n(l.sgst_amount),
    igstAmount: n(l.igst_amount),
    lineTotal: n(l.line_total),
  })),
});

const authErrors = {
  401: jsonError("Missing or invalid token"),
  403: jsonError("Not allowed"),
};

const mine = createRoute({
  method: "get",
  path: "/invoices",
  tags: ["invoices"],
  summary: "My invoices and credit notes",
  description:
    "Read through the caller's own client, so own_invoices decides what comes back. A customer sees the documents for their own orders and nothing else.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: {
      description: "Newest first",
      content: {
        "application/json": { schema: z.object({ items: z.array(Invoice) }) },
      },
    },
    ...authErrors,
  },
});

const list = createRoute({
  method: "get",
  path: "/admin/invoices",
  tags: ["admin", "invoices"],
  summary: "Every invoice",
  description:
    "`unstamped=true` is the e-invoice worker's queue: tax invoices with no IRN yet, backed by idx_invoices_unsigned.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    query: z.object({
      order_id: z.string().uuid().optional(),
      kind: z.enum(["tax_invoice", "credit_note"]).optional(),
      unstamped: z.coerce.boolean().optional(),
      ...pageQuery,
    }),
  },
  responses: {
    200: {
      description: "A page of documents",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(Invoice),
            total: z.number().int().nullable(),
            limit: z.number().int(),
            offset: z.number().int(),
          }),
        },
      },
    },
    400: jsonError("Invalid query"),
    ...authErrors,
  },
});

const detail = createRoute({
  method: "get",
  path: "/admin/invoices/{id}",
  tags: ["admin", "invoices"],
  summary: "One document, with its lines",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "The document", content: { "application/json": { schema: Invoice } } },
    404: jsonError("No such invoice"),
    ...authErrors,
  },
});

const issue = createRoute({
  method: "post",
  path: "/admin/orders/{id}/invoice",
  tags: ["admin", "invoices"],
  summary: "Issue the tax invoice for an order",
  description:
    "Numbered and written in one transaction, so a rollback takes the number back with it -- that is what keeps the series gap-free.\n\n`place_of_supply` is a two-digit state code and defaults to the seller's. The order's address snapshot carries a state NAME, and this schema has no name-to-code table, so the caller resolves it. Getting it wrong changes CGST+SGST into IGST on a document that cannot be edited.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            place_of_supply: z
              .string()
              .regex(/^[0-9]{2}$/, "A GST state code is two digits")
              .optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Issued", content: { "application/json": { schema: Invoice } } },
    400: jsonError("Invalid body"),
    404: jsonError("No such order"),
    409: jsonError("Already invoiced, unpaid, or no seller GSTIN configured"),
    ...authErrors,
  },
});

const creditNote = createRoute({
  method: "post",
  path: "/admin/invoices/{id}/credit-note",
  tags: ["admin", "invoices"],
  summary: "Credit part or all of an invoice",
  description:
    "The only way to correct an issued invoice. Quantities are credited pro rata of each parent line's taxable value, not at list price -- the line already carries its share of the order discount, so crediting at list would refund tax on money the customer never paid.\n\nCredit notes against one invoice cannot exceed it.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            reason: z.string().trim().min(3).max(300),
            return_id: z.string().uuid().optional(),
            lines: z
              .array(
                z.object({
                  invoice_line_id: z.string().uuid(),
                  quantity: z.number().int().positive(),
                }),
              )
              .min(1, "Choose at least one line"),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Issued", content: { "application/json": { schema: Invoice } } },
    400: jsonError("Invalid body"),
    404: jsonError("No such invoice"),
    409: jsonError("Crediting more than the invoice"),
    422: jsonError("Lines not on that invoice, or no reason given"),
    ...authErrors,
  },
});

const stamp = createRoute({
  method: "post",
  path: "/admin/invoices/{id}/einvoice",
  tags: ["admin", "invoices"],
  summary: "Record what the IRP returned",
  description:
    "**Writable once.** After this the IRN, acknowledgement and signed QR are final -- rewriting a signed QR is exactly the tampering the signature exists to make detectable, and the database refuses it.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            // The IRP's hash. A short one is a truncated paste, and it
            // would be permanent.
            irn: z.string().trim().length(64, "An IRN is 64 characters"),
            ack_no: z.string().max(60),
            ack_date: z.string().datetime().optional(),
            signed_qr: z.string().max(8000),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Stamped", content: { "application/json": { schema: Invoice } } },
    400: jsonError("Invalid body"),
    404: jsonError("No such invoice"),
    409: jsonError("Already stamped"),
    ...authErrors,
  },
});

export const invoicingRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(mine, async (c) => {
    const { data, error } = await c
      .get("caller")
      .db.from("invoices")
      // orders!inner, or the filter below narrows the EMBEDDED order and
      // leaves every invoice in the result. PostgREST only propagates a
      // filter on an embedded column when the join is inner.
      .select(INVOICE_SELECT)
      .eq("orders.customer_id", c.get("caller").userId)
      .order("issued_at", { ascending: false });
    throwOnDbError(error);
    return c.json(
      { items: ((data ?? []) as unknown as InvoiceRow[]).map(shape) },
      200,
    );
  })

  .openapi(list, async (c) => {
    const { order_id, kind, unstamped, limit, offset } = c.req.valid("query");
    let query = c
      .get("caller")
      .db.from("invoices")
      .select(INVOICE_SELECT, { count: "exact" });

    if (order_id) query = query.eq("order_id", order_id);
    if (kind) query = query.eq("kind", kind);
    if (unstamped) query = query.is("irn", null).eq("kind", "tax_invoice");

    const { data, error, count } = await query
      .order("issued_at", { ascending: false })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    return c.json(
      {
        items: ((data ?? []) as unknown as InvoiceRow[]).map(shape),
        total: count ?? null,
        limit,
        offset,
      },
      200,
    );
  })

  .openapi(detail, async (c) => {
    const { id } = c.req.valid("param");
    const { data, error } = await c
      .get("caller")
      .db.from("invoices")
      .select(INVOICE_SELECT)
      .eq("id", id)
      .maybeSingle();
    throwOnDbError(error);
    if (!data) {
      throw new HTTPException(404, {
        message: "No such invoice",
        cause: { code: "not_found" },
      });
    }
    return c.json(shape(data as unknown as InvoiceRow), 200);
  })

  .openapi(issue, async (c) => {
    const { id } = c.req.valid("param");
    const { place_of_supply } = c.req.valid("json");
    const db = c.get("caller").db;

    const { data, error } = await db.rpc("admin_issue_invoice", {
      p_order_id: id,
      p_place_of_supply: place_of_supply ?? null,
    });
    throwOnDbError(error);

    const created = await db
      .from("invoices")
      .select(INVOICE_SELECT)
      .eq("id", data as unknown as string)
      .single();
    throwOnDbError(created.error);

    const inv = created.data as unknown as InvoiceRow;
    c.get("log")?.info(
      { orderId: id, invoiceNumber: inv.invoice_number },
      "invoicing.issued",
    );
    return c.json(shape(inv), 201);
  })

  .openapi(creditNote, async (c) => {
    const { id } = c.req.valid("param");
    const { reason, return_id, lines } = c.req.valid("json");
    const db = c.get("caller").db;

    const { data, error } = await db.rpc("admin_issue_credit_note", {
      p_parent_invoice_id: id,
      p_lines: lines,
      p_reason: reason,
      p_return_id: return_id ?? null,
    });
    throwOnDbError(error);

    const created = await db
      .from("invoices")
      .select(INVOICE_SELECT)
      .eq("id", data as unknown as string)
      .single();
    throwOnDbError(created.error);

    const note = created.data as unknown as InvoiceRow;
    c.get("log")?.info(
      { parentInvoiceId: id, creditNote: note.invoice_number },
      "invoicing.credit_note",
    );
    return c.json(shape(note), 201);
  })

  .openapi(stamp, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = c.get("caller").db;

    const { error } = await db.rpc("admin_stamp_einvoice", {
      p_invoice_id: id,
      p_irn: body.irn,
      p_ack_no: body.ack_no,
      p_ack_date: body.ack_date ?? null,
      p_signed_qr: body.signed_qr,
    });
    throwOnDbError(error);

    const after = await db.from("invoices").select(INVOICE_SELECT).eq("id", id).single();
    throwOnDbError(after.error);

    // The IRN identifies the filing and is printed on the invoice, so
    // it is not a secret -- but the signed QR is bulky and pointless in
    // a log line, so neither goes in beyond the number.
    c.get("log")?.info(
      { invoiceNumber: (after.data as unknown as InvoiceRow).invoice_number },
      "invoicing.einvoice_stamped",
    );
    return c.json(shape(after.data as unknown as InvoiceRow), 200);
  });
