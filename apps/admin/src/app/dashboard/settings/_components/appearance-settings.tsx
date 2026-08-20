"use client";

import { useEffect, useState } from "react";

import { useTheme } from "next-themes";

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();

  // The active theme is only known after hydration, so the first client render
  // must match the server's. Hold a disabled placeholder until then.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor="theme">Theme</FieldLabel>
      <Select value={mounted ? theme : undefined} onValueChange={setTheme} disabled={!mounted}>
        <SelectTrigger id="theme" className="w-56">
          <SelectValue placeholder="Loading…" />
        </SelectTrigger>
        <SelectContent>
          {THEME_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>Saved to this browser and applied immediately.</FieldDescription>
    </Field>
  );
}
