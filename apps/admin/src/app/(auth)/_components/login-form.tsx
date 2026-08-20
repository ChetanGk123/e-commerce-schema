"use client";

import { useEffect } from "react";

import Link from "next/link";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

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

function onSubmit(data: z.infer<typeof formSchema>) {
  // Remembers the address only, so the field is pre-filled on this browser next
  // time. How long the session itself lasts is the auth provider's cookie to set
  // — that cannot be done from here.
  if (data.remember) {
    localStorage.setItem(REMEMBERED_EMAIL_KEY, data.email);
  } else {
    localStorage.removeItem(REMEMBERED_EMAIL_KEY);
  }

  // TODO: replace with a call to your auth provider.
  // Never log or render submitted credentials.
  toast.info("Not wired up yet — connect your auth provider in onSubmit.");
}

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
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
      password: "",
      remember: false,
    },
  });

  const { reset } = form;

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
      <Button className="w-full" type="submit">
        Login
      </Button>
    </form>
  );
}
