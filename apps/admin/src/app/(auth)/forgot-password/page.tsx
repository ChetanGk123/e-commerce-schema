import Link from "next/link";

import type { Metadata } from "next";

import { ROUTES } from "@/constants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { ForgotPasswordForm } from "../_components/forgot-password-form";

export const metadata: Metadata = {
  title: "Reset your password",
};

export default function ForgotPasswordPage() {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">
            <h1>Reset your password</h1>
          </CardTitle>
          <CardDescription>We&apos;ll email you a link to choose a new one.</CardDescription>
        </CardHeader>
        <CardContent>
          <ForgotPasswordForm />
        </CardContent>
      </Card>

      <p className="text-center text-muted-foreground text-sm">
        Remembered it?{" "}
        <Link prefetch={false} href={ROUTES.LOGIN} className="text-foreground underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </div>
  );
}
