import Link from "next/link";

import { Lock } from "lucide-react";
import type { Metadata } from "next";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Unauthorized",
};

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-md text-center">
        <Lock className="mx-auto size-12 text-primary" />
        <h1 className="mt-4 font-bold text-3xl tracking-tight sm:text-4xl">Unauthorized Access</h1>
        <p className="mt-4 text-muted-foreground">
          You do not have permission to view the requested content. Please contact the site administrator if you believe
          this is an error.
        </p>
        <div className="mt-6">
          <Button asChild>
            <Link prefetch={false} href="/dashboard">
              Go to Homepage
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
