import Link from "next/link";

import { ArrowRight, Command, Gauge, Palette, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { APP_CONFIG } from "@/config/app-config";

// Placeholder marketing copy. Replace all of it with your product's.
const FEATURES = [
  {
    id: "fast",
    icon: Gauge,
    title: "Fast by default",
    description: "Server Components and streaming, so pages render before the data finishes loading.",
  },
  {
    id: "themed",
    icon: Palette,
    title: "Themed end to end",
    description: "Semantic tokens drive light and dark mode across every component, with no per-screen overrides.",
  },
  {
    id: "secure",
    icon: ShieldCheck,
    title: "Ready to secure",
    description: "Auth screens and route structure are in place — connect the provider you already use.",
  },
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <Command className="size-5" />
            {APP_CONFIG.name}
          </Link>
          <nav className="flex items-center gap-2">
            <Button asChild variant="ghost">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild>
              <Link href="/register">Get started</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto w-full max-w-5xl px-6 py-24 text-center sm:py-32">
          <h1 className="text-balance font-semibold text-4xl tracking-tight sm:text-6xl">
            The admin dashboard you didn&apos;t have to build
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg text-muted-foreground">
            Layout, navigation, theming, and auth screens are already wired together. Start with the screens that make
            your product yours.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/register">
                Get started
                <ArrowRight data-icon="inline-end" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/dashboard">View the dashboard</Link>
            </Button>
          </div>
        </section>

        <section className="mx-auto w-full max-w-5xl px-6 pb-24">
          <div className="grid gap-4 md:grid-cols-3">
            {FEATURES.map((feature) => (
              <Card key={feature.id}>
                <CardHeader>
                  <feature.icon className="mb-2 size-5 text-muted-foreground" />
                  <CardTitle>{feature.title}</CardTitle>
                  <CardDescription>{feature.description}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-6 py-6 text-muted-foreground text-sm">
          <span>
            © {new Date().getFullYear()} {APP_CONFIG.name}
          </span>
          <Link href="/dashboard" className="hover:text-foreground">
            Dashboard
          </Link>
        </div>
      </footer>
    </div>
  );
}
