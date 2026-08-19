-- ============================================================
-- 0018  GST invoicing: credit notes and the e-invoice stamp
--
-- An invoice is the one document here that a government reads. It
-- cannot be edited, it cannot be deleted, and its number cannot skip.
-- Everything below works around those three facts rather than against
-- them.
--
-- A mistake on an issued invoice is corrected by a CREDIT NOTE -- a
-- second document, positively valued, pointing at the first. That is
-- why admin_issue_credit_note exists and why there is no
-- admin_amend_invoice.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- The e-invoice stamp is final once recorded
--
-- protect_invoice() already pinned the IRN. It did not pin ack_no,
-- ack_date or signed_qr, so the signed QR on a filed invoice could be
-- replaced after the fact while the IRN it belongs to stayed put --
-- which is precisely the tampering the signature exists to make
-- detectable.
--
-- pdf_url stays mutable on purpose: regenerating a PDF from unchanged
-- data is housekeeping, not an amendment.
-- ------------------------------------------------------------

create or replace function protect_invoice()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  mutable_fields text[] := array['pdf_url', 'irn', 'ack_no', 'ack_date', 'signed_qr'];
begin
  if tg_op = 'DELETE' then
    raise exception 'invoices are permanent legal documents: delete not allowed'
      using errcode = 'restrict_violation';
  end if;

  if (to_jsonb(new) - mutable_fields) is distinct from (to_jsonb(old) - mutable_fields) then
    raise exception
      'invoices are immutable: only pdf_url and the e-invoice fields may be updated (issue a credit_note instead)'
      using errcode = 'restrict_violation';
  end if;

  -- Once the IRP has answered, the whole stamp is the IRP's, not ours.
  if old.irn is not null and (
       new.irn       is distinct from old.irn
    or new.ack_no    is distinct from old.ack_no
    or new.ack_date  is distinct from old.ack_date
    or new.signed_qr is distinct from old.signed_qr) then
    raise exception
      'the e-invoice stamp is issued by the IRP and is final once recorded'
      using errcode = 'restrict_violation';
  end if;

  return new;
end $$;

-- ------------------------------------------------------------
-- Record what the IRP returned
--
-- Separate from issuing because the two happen minutes or hours
-- apart: the invoice is a legal document the moment it is numbered,
-- and the IRP is a third party that can be down.
-- ------------------------------------------------------------

create or replace function admin_stamp_einvoice(
  p_invoice_id uuid,
  p_irn        text,
  p_ack_no     text,
  p_ack_date   timestamptz,
  p_signed_qr  text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  inv invoices%rowtype;
begin
  if p_irn is null or length(btrim(p_irn)) <> 64 then
    -- An IRN is the IRP's 64-character hash. A shorter one is a
    -- truncated paste, and it would be permanent.
    raise exception 'An IRN is 64 characters. That one is %.',
      coalesce(length(btrim(p_irn)), 0)
      using errcode = 'ECOM1', hint = 'invalid_irn';
  end if;

  select * into inv from invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice % not found', p_invoice_id using errcode = 'P0002';
  end if;
  if inv.irn is not null then
    raise exception 'Invoice % is already stamped.', inv.invoice_number
      using errcode = 'ECOM2', hint = 'already_stamped';
  end if;

  update invoices
  set irn = btrim(p_irn), ack_no = p_ack_no,
      ack_date = coalesce(p_ack_date, now()), signed_qr = p_signed_qr
  where id = p_invoice_id;

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (inv.order_id, 'einvoice_stamped', inv.invoice_number, 'staff', uid);
end $$;

-- ------------------------------------------------------------
-- Credit note
--
-- The only way to correct an issued invoice. Positively valued and
-- of kind 'credit_note', which is how GST expects it: a negative
-- invoice is not a thing, a second document is.
--
-- Quantities are credited PRO RATA of the parent line's
-- taxable_value, not at unit_price * quantity. The parent line
-- already carries its share of the order discount, so crediting at
-- list price would refund tax on money the customer never paid.
--
-- Numbering comes from next_invoice_number(), the same series as tax
-- invoices. One consecutive series per financial year is what Rule 46
-- asks for; it does not require a separate one for credit notes. The
-- 'INV/' prefix on a credit note reads oddly and is left alone --
-- changing the format would renumber nothing and confuse everything
-- already filed.
-- ------------------------------------------------------------

create or replace function admin_issue_credit_note(
  p_parent_invoice_id uuid,
  p_lines             jsonb,     -- [{"invoice_line_id": uuid, "quantity": int}]
  p_reason            text,
  p_return_id         uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid         uuid := require_staff();
  parent      invoices%rowtype;
  s           store_settings%rowtype;
  same_state  boolean;
  credited    numeric(12,2);
  v_lines     jsonb;
  tot         record;
  note_id     uuid;
  note_no     text;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A credit note has to say what it is for.'
      using errcode = 'ECOM1', hint = 'reason_required';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Choose at least one line to credit.'
      using errcode = 'ECOM1', hint = 'no_lines';
  end if;

  select * into parent from invoices where id = p_parent_invoice_id for update;
  if not found then
    raise exception 'invoice % not found', p_parent_invoice_id using errcode = 'P0002';
  end if;
  if parent.kind <> 'tax_invoice' then
    raise exception 'A credit note is issued against a tax invoice, not against %.',
      parent.kind using errcode = 'ECOM1', hint = 'not_a_tax_invoice';
  end if;

  select * into s from store_settings where id = 1;
  same_state := (parent.place_of_supply = s.seller_state_code);

  -- Build the lines from the PARENT's, pro rata by quantity.
  select jsonb_agg(jsonb_build_object(
           'description',   pl.description,
           'hsn_code',      pl.hsn_code,
           'quantity',      req.quantity,
           'unit_price',    pl.unit_price,
           'taxable_value', t.taxable,
           'gst_rate',      pl.gst_rate,
           'cgst_amount',   case when same_state then t.half else 0 end,
           'sgst_amount',   case when same_state then t.half else 0 end,
           'igst_amount',   case when same_state then 0 else 2 * t.half end,
           'line_total',    t.taxable + 2 * t.half))
    into v_lines
  from jsonb_to_recordset(p_lines) as req(invoice_line_id uuid, quantity int)
  join invoice_lines pl on pl.id = req.invoice_line_id
                       and pl.invoice_id = p_parent_invoice_id
  cross join lateral (
    select round(pl.taxable_value * req.quantity / pl.quantity, 2) as taxable
  ) b
  cross join lateral (
    -- The same half that checkout and admin_issue_invoice use, so a
    -- credit note reverses exactly what was charged.
    select b.taxable,
           round(b.taxable * pl.gst_rate / 200, 2) as half
  ) t
  where req.quantity > 0 and req.quantity <= pl.quantity;

  if v_lines is null or jsonb_array_length(v_lines) <> jsonb_array_length(p_lines) then
    raise exception 'One or more lines are not on that invoice, or credit more than was billed.'
      using errcode = 'ECOM1', hint = 'invalid_lines';
  end if;

  select sum(taxable_value) as taxable, sum(cgst_amount) as cgst,
         sum(sgst_amount) as sgst, sum(igst_amount) as igst, sum(line_total) as total
    into tot
  from jsonb_to_recordset(v_lines) as x(
    taxable_value numeric, cgst_amount numeric,
    sgst_amount numeric, igst_amount numeric, line_total numeric);

  -- Credit notes against one invoice cannot exceed it. Crediting more
  -- than was charged is a refund of money that never arrived, and the
  -- return would be filed as input credit the buyer is not owed.
  select coalesce(sum(grand_total), 0) into credited
  from invoices where parent_invoice_id = p_parent_invoice_id and kind = 'credit_note';

  if credited + tot.total > parent.grand_total then
    raise exception
      'Crediting % would take the total credited to % against an invoice of %.',
      tot.total, credited + tot.total, parent.grand_total
      using errcode = 'ECOM2', hint = 'over_credit';
  end if;

  -- Number and document in one transaction: a rollback takes the
  -- number with it, which is what keeps the series gap-free.
  note_no := next_invoice_number();

  insert into invoices (
    invoice_number, order_id, kind, parent_invoice_id,
    customer_name, customer_gstin, billing_address,
    seller_gstin, place_of_supply,
    taxable_value, cgst_total, sgst_total, igst_total, grand_total)
  values (
    note_no, parent.order_id, 'credit_note', parent.id,
    parent.customer_name, parent.customer_gstin, parent.billing_address,
    parent.seller_gstin, parent.place_of_supply,
    tot.taxable, tot.cgst, tot.sgst, tot.igst, tot.total)
  returning id into note_id;

  insert into invoice_lines (
    invoice_id, description, hsn_code, quantity, unit_price,
    taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total)
  select note_id, x.description, x.hsn_code, x.quantity, x.unit_price,
         x.taxable_value, x.gst_rate, x.cgst_amount, x.sgst_amount,
         x.igst_amount, x.line_total
  from jsonb_to_recordset(v_lines) as x(
    description text, hsn_code text, quantity int, unit_price numeric,
    taxable_value numeric, gst_rate numeric, cgst_amount numeric,
    sgst_amount numeric, igst_amount numeric, line_total numeric);

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (parent.order_id, 'credit_note_issued',
          note_no || ': ' || btrim(p_reason), 'staff', uid);

  if p_return_id is not null then
    update return_requests set updated_at = now() where id = p_return_id;
  end if;

  return note_id;
end $$;

revoke execute on function admin_stamp_einvoice(uuid, text, text, timestamptz, text) from public;
revoke execute on function admin_issue_credit_note(uuid, jsonb, text, uuid)           from public;
grant  execute on function admin_stamp_einvoice(uuid, text, text, timestamptz, text) to authenticated;
grant  execute on function admin_issue_credit_note(uuid, jsonb, text, uuid)           to authenticated;

commit;
