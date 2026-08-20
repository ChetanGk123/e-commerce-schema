"use client";

import { useId } from "react";

import { type Control, Controller, type FieldPath, type FieldValues } from "react-hook-form";

import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";

import { RequiredMark } from "./required-mark";

type FormCheckboxProps<T extends FieldValues> = {
  readonly control: Control<T>;
  readonly name: FieldPath<T>;
  readonly label: string;
  readonly description?: string;
  /** Marks the label with an asterisk and the control with aria-required. */
  readonly required?: boolean;
};

export function FormCheckbox<T extends FieldValues>({
  control,
  name,
  label,
  description,
  required,
}: FormCheckboxProps<T>) {
  const id = useId();

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field orientation="horizontal" data-invalid={fieldState.invalid}>
          <Checkbox
            id={id}
            name={field.name}
            checked={Boolean(field.value)}
            onCheckedChange={(checked) => field.onChange(Boolean(checked))}
            onBlur={field.onBlur}
            aria-invalid={fieldState.invalid}
            aria-required={required}
          />
          <FieldContent>
            <FieldLabel htmlFor={id} className="font-normal">
              {label}
              {required && <RequiredMark />}
            </FieldLabel>
            {description && <FieldDescription>{description}</FieldDescription>}
            <FieldError errors={[fieldState.error]} />
          </FieldContent>
        </Field>
      )}
    />
  );
}
