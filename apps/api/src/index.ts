/**
 * Package entry. Front ends import AppType from here for `hc`:
 *
 *   import { hc } from "hono/client";
 *   import type { AppType } from "@ecom/api";
 *   const api = hc<AppType>(process.env.API_URL!);
 *
 * Importing this does not start a server -- that is src/server.ts.
 */
export { app, type AppType } from "./app";
