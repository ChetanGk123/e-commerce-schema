import { describe, expect, test } from "bun:test";

import { app } from "../src/app";
import { BUILT_IN } from "../src/mailer";

/**
 * The template manager's contract.
 *
 * Saving, reverting and previewing all need a database, and are verified
 * against the live stack by hand. What runs in-process is the shape of
 * the surface -- which is where this feature could go wrong quietly: an
 * endpoint that let you invent a key would create a template nothing
 * renders, and one that let you delete a built-in would leave the store
 * unable to send a password reset at all.
 */
const doc = async () =>
  (await (await app.request("/openapi.json")).json()) as {
    paths: Record<
      string,
      Record<string, { security?: unknown[]; responses: Record<string, unknown> }>
    >;
    components: { schemas: Record<string, unknown> };
  };

const req = (path: string, method = "GET", body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("who may edit the copy customers receive", () => {
  test.each([
    ["/admin/email-templates", "GET"],
    ["/admin/email-templates/password_reset", "GET"],
    ["/admin/email-templates/password_reset", "PUT"],
    ["/admin/email-templates/password_reset", "DELETE"],
    ["/admin/email-templates/password_reset/preview", "POST"],
  ])("%s %s is 401 without a token", async (path, method) => {
    expect((await req(path, method, method === "GET" ? undefined : {})).status).toBe(401);
  });

  test("every route declares the role gate", async () => {
    const paths = (await doc()).paths;
    for (const [p, m] of [
      ["/admin/email-templates", "get"],
      ["/admin/email-templates/{key}", "get"],
      ["/admin/email-templates/{key}", "put"],
      ["/admin/email-templates/{key}", "delete"],
      ["/admin/email-templates/{key}/preview", "post"],
    ] as const) {
      const op = paths[p]?.[m];
      expect(`${m} ${p}: ${op ? Object.keys(op.responses).join(",") : "MISSING"}`).toContain("403");
    }
  });
});

describe("the catalogue is closed", () => {
  test("there is no POST that could invent a template", async () => {
    // Keys come from mailer.ts. A created key would be a template nothing
    // ever renders, with nothing to notice it.
    const paths = (await doc()).paths;
    expect(Object.keys(paths["/admin/email-templates"] ?? {})).not.toContain("post");
  });

  test("PUT declares 404, so an unknown key is refused rather than created", async () => {
    const responses = (await doc()).paths["/admin/email-templates/{key}"]?.put?.responses;
    expect(Object.keys(responses ?? {})).toContain("404");
    // And 422 for the case that matters: a body that drops {{code}}.
    expect(Object.keys(responses ?? {})).toContain("422");
  });

  test("every built-in declares the variables it cannot do without", () => {
    // A key whose `required` is empty could be saved as empty copy and
    // nothing would object.
    for (const [key, def] of Object.entries(BUILT_IN)) {
      expect(`${key}: ${def.required.length > 0}`).toBe(`${key}: true`);
      // Required variables must actually appear in the shipped default,
      // or the default itself is the broken template.
      for (const r of def.required) {
        expect(`${key} default has {{${r}}}: ${def.body.includes(`{{${r}}}`)}`).toBe(
          `${key} default has {{${r}}}: true`,
        );
      }
    }
  });

  test("preview is a POST that sends nothing", async () => {
    const op = (await doc()).paths["/admin/email-templates/{key}/preview"]?.post;
    expect(op).toBeTruthy();
    // No 202: nothing is queued. If this ever starts returning one,
    // someone has made "preview" deliver mail to a real person.
    expect(Object.keys(op?.responses ?? {})).not.toContain("202");
  });
});
