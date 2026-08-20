/**
 * Staff identity, from the shared schema package.
 *
 * Re-exported rather than redeclared: `STAFF_ROLES` is the same const array
 * the database CHECK constraint and the API's role guards are built from, so
 * a role that does not exist cannot compile here either. Redeclaring the
 * union would let this app drift from the one place it is enforced.
 *
 * `user.ts` holds `DemoUser`, which is the template's placeholder data and
 * unrelated -- it goes when the first real screen lands.
 */
export { STAFF_ROLES, type StaffRole } from "@ecom/schema/enums";
