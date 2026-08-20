-- ============================================================
-- 0035  invoices.pdf_url is deliberately never written
--
-- T11 of docs/image-management.md, and a smaller change than the task
-- proposed.
--
-- Decision 2 of 2026-08-20: invoices are rendered as HTML and printed by
-- the browser. No PDF is ever stored, so nothing writes this column and
-- nothing will under that decision.
--
-- The task said drop it or comment it. DROPPING IT IS THE WRONG TRADE,
-- and the reasons are written here so it is not re-proposed:
--
--   It is named in protect_invoice()'s mutable_fields, in that
--   function's error message, and in two invariants that exist
--   specifically to prove a filed invoice is immutable EXCEPT here.
--   Dropping the column means editing the guard on GST legal records and
--   deleting invariants -- a wide, delicate change whose entire benefit
--   is the absence of an always-null column.
--
--   The decision is reversible in a way the column is not free to
--   recreate. Archiving signed e-invoice PDFs is a plausible statutory
--   requirement; if that day comes, this column and its existing
--   exemption in protect_invoice() are exactly right, and re-adding both
--   is more work than leaving them.
--
-- What WAS misleading is fixed: routes/invoicing.ts published `pdfUrl`
-- on every invoice, telling every client there was a file to fetch. That
-- field is gone from the response.
-- ============================================================

begin;

comment on column invoices.pdf_url is
  'Unused by decision (2026-08-20): invoices are rendered as HTML and '
  'printed by the browser, so no PDF is stored. Kept rather than dropped '
  'because protect_invoice() and two invariants name it, and archiving '
  'signed e-invoice PDFs would want exactly this column back. Not '
  'exposed by the API. See docs/image-management.md T11.';

commit;
