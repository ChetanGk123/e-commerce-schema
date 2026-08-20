"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { FormInput } from "@/components/form/form-input";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";

const formSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email address." }),
});

function onSubmit(_data: z.infer<typeof formSchema>) {
  // TODO: replace with a call to your auth provider.
  // Respond identically whether or not the address exists, so this cannot be
  // used to discover which emails are registered.
  toast.info("Not wired up yet — send the reset email in onSubmit.");
}

export function ForgotPasswordForm() {
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "" },
  });

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
        />
      </FieldGroup>
      <Button className="w-full" type="submit">
        Send reset link
      </Button>
    </form>
  );
}
