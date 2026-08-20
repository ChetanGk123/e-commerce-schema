"use client";

import { useEffect, useState, useTransition } from "react";

import Link from "next/link";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { signIn } from "@/app/(auth)/_actions/sign-in";
import { FormCheckbox } from "@/components/form/form-checkbox";
import { FormInput } from "@/components/form/form-input";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { REMEMBERED_EMAIL_KEY } from "@/constants";

const formSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email address." }),
  password: z.string().min(6, { message: "Password must be at least 6 characters." }),
  remember: z.boolean().optional(),
});

function ForgotPasswordLink() {
  return (
    <Link
      prefetch={false}
      href="/forgot-password"
      className="text-muted-foreground text-xs underline underline-offset-4 hover:text-foreground"
    >
      Forgot password?
    </Link>
  );
}

export function LoginForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
      password: "",
      remember: false,
    },
  });

  const { reset } = form;

  // The password goes to a Server Action, never to a fetch this component
  // composes: it is posted to the server process and the session comes back as
  // an httpOnly cookie set in the same round trip, so script on this page never
  // holds a token it could leak.
  function onSubmit(data: z.infer<typeof formSchema>) {
    // The address only, so the field is pre-filled next time. Never the password.
    if (data.remember) {
      localStorage.setItem(REMEMBERED_EMAIL_KEY, data.email);
    } else {
      localStorage.removeItem(REMEMBERED_EMAIL_KEY);
    }

    setError(null);
    startTransition(async () => {
      // Resolves only on failure -- success redirects, which throws to unwind.
      const result = await signIn(data.email, data.password);
      setError(result.error);
      toast.error(result.error);
    });
  }

  // Read after mount, not during render: localStorage does not exist on the
  // server, and seeding defaultValues from it would mismatch on hydration.
  useEffect(() => {
    const rememberedEmail = localStorage.getItem(REMEMBERED_EMAIL_KEY);

    if (rememberedEmail) {
      reset({ email: rememberedEmail, password: "", remember: true });
    }
  }, [reset]);

  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <FormInput
          control={form.control}
          name="email"
          label="Email Address"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          required
        />
        <FormInput
          control={form.control}
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          labelAction={<ForgotPasswordLink />}
        />
        <FormCheckbox
          control={form.control}
          name="remember"
          label="Remember me"
          description="Fills in your email next time on this browser."
        />
      </FieldGroup>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button className="w-full" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Login"}
      </Button>
    </form>
  );
}
