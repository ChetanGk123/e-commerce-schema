"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { FormInput } from "@/components/form/form-input";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";

const formSchema = z.object({
  name: z.string().min(1, { message: "Name is required." }).max(80, { message: "Name is too long." }),
  email: z.string().email({ message: "Please enter a valid email address." }),
});

export type ProfileValues = z.infer<typeof formSchema>;

function onSubmit(_values: ProfileValues) {
  // TODO: persist through a Server Action or your API.
  toast.info("Not wired up yet — save the profile in onSubmit.");
}

export function ProfileForm({ defaultValues }: { readonly defaultValues: ProfileValues }) {
  const form = useForm<ProfileValues>({
    resolver: zodResolver(formSchema),
    defaultValues,
  });

  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <FormInput control={form.control} name="name" label="Name" autoComplete="name" />
        <FormInput control={form.control} name="email" label="Email" type="email" autoComplete="email" />
      </FieldGroup>
      <div className="flex justify-end">
        <Button type="submit">Save changes</Button>
      </div>
    </form>
  );
}
