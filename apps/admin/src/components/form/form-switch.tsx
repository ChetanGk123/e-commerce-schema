"use client";

import { useId } from "react";

import { type Control, Controller, type FieldPath, type FieldValues } from "react-hook-form";

import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

import { RequiredMark } from "./required-mark";

type FormSwitchProps<T extends FieldValues> = {
  readonly control: Control<T>;
  readonly name: FieldPath<T>;
  readonly label: string;
  readonly description?: string;
  /** Marks the label with an asterisk and the control with aria-required. */
  readonly required?: boolean;
};

export function FormSwitch<T extends FieldValues>({ control, name, label, description, required }: FormSwitchProps<T>) {
  const id = useId();

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field orientation="horizontal" data-invalid={fieldState.invalid}>
          <FieldContent>
            <FieldLabel htmlFor={id} className="font-normal">
              {label}
              {required && <RequiredMark />}
            </FieldLabel>
            {description && <FieldDescription>{description}</FieldDescription>}
            <FieldError errors={[fieldState.error]} />
          </FieldContent>
          <Switch
            id={id}
            name={field.name}
            checked={Boolean(field.value)}
            onCheckedChange={field.onChange}
            onBlur={field.onBlur}
            aria-invalid={fieldState.invalid}
            aria-required={required}
          />
        </Field>
      )}
    />
  );
}
