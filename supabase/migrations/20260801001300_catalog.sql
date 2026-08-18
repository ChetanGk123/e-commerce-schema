-- ============================================================
-- 0013  Catalog: typo-tolerant search, and one shipping quote
--
-- Two reads the API cannot express through PostgREST, for opposite
-- reasons.
--
-- search_products: PostgREST has no operator for pg_trgm similarity.
-- Without this the storefront falls back to ILIKE, which cannot find
-- "iPhone charger" from "iphone chrger" -- the exact case the gin
-- trigram indexes were created for.
--
-- shipping_quote: expressible as three round trips, but the band
-- predicate has to mirror rates_no_overlap exactly or the customer is
-- charged the wrong amount. It lives beside that constraint instead.
--
-- Both are SECURITY INVOKER, deliberately. RLS then does the scoping
-- for free: anon sees only active products because public_read says
-- so, staff see drafts because staff_all says so, and one function
-- serves the storefront and the admin without a role flag that could
-- be got wrong.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Fuzzy catalog search
--
-- word_similarity, not similarity: similarity() compares whole
-- strings, so "macbook" against "MacBook Air 13-inch M3" scores low
-- and the product a shopper is obviously looking for does not come
-- back. word_similarity scores the query against the best matching
-- run inside the name, which is what a search box means.
--
-- `name %> q` is the commutator of `q <% name`, and it is the form
-- that uses idx_products_name_trgm.
--
-- Two arms, both served by the same gin index. `%>` catches typos;
-- ILIKE catches the substring queries word_similarity scores badly
-- ("air" inside "MacBook Air").
--
-- The threshold is pinned per call. pg_trgm.word_similarity_threshold
-- defaults to 0.6, and 0.6 rejects word_similarity('aple','Apple') =
-- 0.571 -- one dropped letter in a short brand name, which is the most
-- common typo there is. It cannot go in the function's SET clause:
-- pg_trgm is not preloaded, so at DDL time the GUC is a placeholder and
-- setting one needs superuser. set_config at runtime is not subject to
-- that, and is_local => it is scoped to the statement's transaction
-- rather than left behind on a pooled connection.
-- ------------------------------------------------------------

create or replace function search_products(p_q text, p_limit int default 20)
returns table (
  id          uuid,
  slug        text,
  name        text,
  brand       text,
  description text,
  category_id uuid,
  status      text,
  score       real
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  perform set_config('pg_trgm.word_similarity_threshold', '0.35', true);

  return query
  with q as (
    select btrim(coalesce(p_q, '')) as raw
  ),
  pat as (
    -- % and _ are wildcards. Unescaped, a search for "50%" matches the
    -- whole catalog -- not an injection, but the same shape of bug.
    select q.raw,
           -- E'' throughout: with standard_conforming_strings on, '\\' is
           -- TWO backslashes, so the plain form escapes nothing.
           '%' || replace(replace(replace(q.raw, E'\\', E'\\\\'),
                                  '%', E'\\%'), '_', E'\\_') || '%' as like_pat
    from q
  )
  select hit.id, hit.slug, hit.name, hit.brand, hit.description,
         hit.category_id, hit.status, hit.score
  from (
    select p.id, p.slug, p.name, p.brand, p.description,
           p.category_id, p.status,
           greatest(word_similarity(pat.raw, p.name),
                    word_similarity(pat.raw, coalesce(p.brand, '')))::real as score
    from products p
    cross join pat
    -- A one-character query matches most of the catalog and cannot use
    -- the trigram index, so it is not a search -- it is a table scan.
    where length(pat.raw) >= 2
      and (p.name  %> pat.raw
        or p.brand %> pat.raw
        or p.name  ilike pat.like_pat
        or p.brand ilike pat.like_pat)
  ) hit
  order by hit.score desc, hit.name
  -- Clamped: an unbounded limit from a query string is a free full scan.
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
end $$;

comment on function search_products(text, int) is
  'Typo-tolerant product search over name and brand. SECURITY INVOKER, so '
  'RLS decides visibility: anon gets active products, staff get drafts too.';

-- ------------------------------------------------------------
-- "Deliver to 560001?", and what it costs
--
-- Returns ZERO ROWS when the pincode is not serviceable. That is the
-- answer, not an error -- callers check for the empty result.
--
-- One row otherwise, because rates_no_overlap guarantees at most one
-- active band can match a (zone, weight, basket value) point. The
-- predicate below is half-open on both axes to match that constraint's
-- '[)' ranges. docs/schema_guide.md used BETWEEN, which is inclusive
-- at the top: a 500g parcel matched both the [0,500) and the [500,1000)
-- band, and the price the customer saw depended on the plan.
-- ------------------------------------------------------------

create or replace function shipping_quote(
  p_pincode      text,
  p_weight_grams int     default 0,
  p_order_total  numeric default 0
)
returns table (
  zone_id       uuid,
  cod_allowed   boolean,
  courier       text,
  rate          numeric(12,2),
  cod_surcharge numeric(12,2),
  delivery_days int,
  free_shipping boolean,
  rate_source   text
)
language sql
stable
set search_path = public, pg_temp
as $$
  with sp as (
    select * from serviceable_pincodes where pincode = p_pincode
  ),
  -- public_settings, not store_settings: the latter is staff-only, so a
  -- shopper calling this would silently get no settings and the wrong
  -- fallback rate.
  st as (
    select cod_enabled, free_shipping_above, flat_shipping_rate
    from public_settings
    limit 1
  ),
  band as (
    select sr.id, sr.rate, sr.cod_surcharge, sr.delivery_days
    from shipping_rates sr
    join sp on sp.zone_id = sr.zone_id
    where sr.is_active
      and p_weight_grams >= sr.min_weight_grams
      and (sr.max_weight_grams is null or p_weight_grams < sr.max_weight_grams)
      and p_order_total  >= sr.min_order_total
      and (sr.max_order_total is null or p_order_total < sr.max_order_total)
  ),
  free as (
    select st.free_shipping_above is not null
       and p_order_total >= st.free_shipping_above as yes
    from st
  )
  select
    sp.zone_id,
    -- Both have to agree: the store can switch COD off globally, and a
    -- single pincode can be barred while the store still offers it.
    sp.cod_allowed and coalesce(st.cod_enabled, false),
    sp.courier,
    case when coalesce(free.yes, false) then 0
         else coalesce(band.rate, st.flat_shipping_rate, 0) end::numeric(12,2),
    coalesce(band.cod_surcharge, 0)::numeric(12,2),
    band.delivery_days,
    coalesce(free.yes, false),
    case when coalesce(free.yes, false) then 'free_shipping'
         when band.id is not null       then 'zone_rate'
         else                                'flat_rate' end
  -- left joins throughout: a pincode with no zone, or a zone with no
  -- matching band, still answers "we deliver there" at the flat rate.
  from sp
  left join st   on true
  left join free on true
  left join band on true;
$$;

comment on function shipping_quote(text, int, numeric) is
  'Serviceability and price for one pincode. Zero rows means not '
  'serviceable. Checkout must price shipping through this function, or the '
  'quote the customer saw and the amount they are charged can disagree.';

revoke execute on function search_products(text, int)            from public;
revoke execute on function shipping_quote(text, int, numeric)    from public;
grant  execute on function search_products(text, int)            to anon, authenticated;
grant  execute on function shipping_quote(text, int, numeric)    to anon, authenticated;

commit;
