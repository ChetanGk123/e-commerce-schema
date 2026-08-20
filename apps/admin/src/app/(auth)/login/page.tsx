import Link from "next/link";

import type { Metadata } from "next";

import { ROUTES } from "@/constants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { LoginForm } from "../_components/login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function LoginPage() {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          {/* Tailwind's preflight resets heading size and weight, so the h1 inherits
              CardTitle's styling while giving the page a real top-level heading. */}
          <CardTitle className="text-xl">
            <h1>Sign in</h1>
          </CardTitle>
          <CardDescription>Enter your email and password to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>

      <p className="text-center text-muted-foreground text-sm">
        Don&apos;t have an account?{" "}
        <Link prefetch={false} href={ROUTES.REGISTER} className="text-foreground underline underline-offset-4">
          Create one
        </Link>
      </p>
    </div>
  );
}
