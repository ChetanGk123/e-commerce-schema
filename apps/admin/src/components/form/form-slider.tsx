"use client";

import { type Control, Controller, type FieldPath, type FieldValues } from "react-hook-form";

import { Field, FieldDescription, FieldError, FieldTitle } from "@/components/ui/field";
import { Slider } from "@/components/ui/slider";

type FormSliderProps<T extends FieldValues> = {
  readonly control: Control<T>;
  readonly name: FieldPath<T>;
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly description?: string;
};

// The label is a FieldTitle, not a FieldLabel: the Radix slider root is not a
// labelable element, so the accessible name comes from aria-label instead.
export function FormSlider<T extends FieldValues>({
  control,
  name,
  label,
  min = 0,
  max = 100,
  step = 1,
  description,
}: FormSliderProps<T>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const value = typeof field.value === "number" ? field.value : min;

        return (
          <Field className="gap-1.5" data-invalid={fieldState.invalid}>
            <div className="flex items-center justify-between gap-2">
              <FieldTitle>{label}</FieldTitle>
              <span className="text-muted-foreground text-sm tabular-nums">{value}</span>
            </div>
            <Slider
              aria-label={label}
              min={min}
              max={max}
              step={step}
              value={[value]}
              onValueChange={(next) => field.onChange(next[0])}
              onBlur={field.onBlur}
            />
            {description && !fieldState.invalid && <FieldDescription>{description}</FieldDescription>}
            <FieldError errors={[fieldState.error]} />
          </Field>
        );
      }}
    />
  );
}
