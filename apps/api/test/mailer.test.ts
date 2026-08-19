import { describe, expect, test } from "bun:test";

import { BUILT_IN, type Message, interpolate, mailProvider, render } from "../src/mailer";

/**
 * Templates and provider selection.
 *
 * Delivery itself is proven against a real SMTP conversation by hand --
 * a socket does not belong in a unit test. What belongs here is the part
 * that silently ruins a reset email: a template that renders without the
 * code in it. That email is worse than no email, because the customer
 * has no way to know it was broken rather than late.
 */
const msg = (template: string, payload: Record<string, unknown> = {}): Message => ({
  id: "00000000-0000-4000-8000-000000000001",
  channel: "email",
  template,
  recipient: "shopper@test.local",
  payload,
  attempts: 0,
});

describe("an auth email is worthless without its code", () => {
  test.each([["password_reset"], ["signup_confirmation"], ["staff_invite"], ["email_change"]])(
    "%s carries the code and a subject",
    (template) => {
      const { subject, text } = render(msg(template, { code: "406279" }));
      expect(text).toContain("406279");
      expect(subject.length).toBeGreaterThan(0);
      // The generic fallback would quietly swallow a new template.
      expect(subject).not.toContain("your order");
    },
  );

  test("a missing code does not render the word undefined at someone", () => {
    const { text } = render(msg("password_reset"));
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
  });

  test("no auth email carries a link", () => {
    // The only link GoTrue offers points at the internal kong host, which
    // is unreachable from a customer's machine. Codes travel; links here
    // do not.
    for (const t of ["password_reset", "signup_confirmation", "staff_invite", "email_change"]) {
      const { text } = render(msg(t, { code: "406279" }));
      expect(text).not.toContain("http");
    }
  });

  test("order confirmation still renders, unchanged", () => {
    const { subject, text } = render(
      msg("order_confirmation", { order_number: "ORD-2026-00048", grand_total: 1915.14 }),
    );
    expect(subject).toContain("ORD-2026-00048");
    expect(text).toContain("1915.14");
  });
});

describe("provider selection", () => {
  test("resolves to something the send path understands", () => {
    // Whatever this environment is configured for, it must be one of the
    // three the dispatcher branches on -- a fourth value would fall
    // through to Resend and send with the wrong credentials.
    expect(["resend", "smtp", "none"]).toContain(mailProvider());
  });
});

describe("a customised template overrides the built-in", () => {
  const reset = (payload: Record<string, unknown> = { code: "406279" }) =>
    msg("password_reset", payload);

  test("a valid override is what gets sent", () => {
    const out = render(reset(), {
      subject: "Chetan Store -- your code",
      body: "Your code is {{code}}.",
    });
    expect(out.subject).toBe("Chetan Store -- your code");
    expect(out.text).toBe("Your code is 406279.");
    expect(out.usedOverride).toBe(true);
  });

  /**
   * The backstop that matters. `staff_all` lets any staff member write
   * message_templates straight through PostgREST, so the API refusing to
   * SAVE a codeless reset is not enough -- the renderer has to refuse to
   * SEND one. Verified against the live stack too: a poisoned row written
   * by psql still delivered the built-in, code intact.
   */
  test("an override that drops a required variable is ignored", () => {
    const out = render(reset(), {
      subject: "Broken",
      body: "Click the thing. No code included.",
    });
    expect(out.usedOverride).toBe(false);
    expect(out.text).toContain("406279");
    expect(out.subject).toBe(BUILT_IN.password_reset!.subject);
  });

  test("a newline in a subject cannot become a header", () => {
    // The CHECK constraint refuses this on the way in; this is the last
    // line before the header is written, and it must not depend on how
    // the text got here.
    const out = render(reset(), {
      subject: "Hi\nBcc: attacker@evil.com",
      body: "code {{code}}",
    });
    expect(out.subject).not.toContain("\n");
    expect(out.subject).toBe("Hi Bcc: attacker@evil.com");
  });
});

describe("interpolation is substitution, not evaluation", () => {
  test("a known variable is replaced", () => {
    expect(interpolate("code {{code}}", { code: "1" })).toBe("code 1");
  });

  test("an unknown variable renders empty, not as braces", () => {
    // A template naming a variable that no longer exists should read
    // plain, not broken.
    expect(interpolate("a{{nope}}b", {})).toBe("ab");
  });

  test("whitespace inside the braces is tolerated", () => {
    expect(interpolate("{{ code }}", { code: "9" })).toBe("9");
  });

  test("nothing is executed", () => {
    // No conditionals, no loops, no property access -- staff-editable
    // content run through an engine is a code-execution surface.
    const out = interpolate("{{a.b}} {{a[0]}} {{#if x}}y{{/if}}", { a: "X", x: 1 });
    expect(out).toBe("{{a.b}} {{a[0]}} {{#if x}}y{{/if}}");
  });
});
