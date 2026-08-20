"use client";

import type * as React from "react";
import { useId } from "react";

import { type Control, Controller, type FieldPath, type FieldValues } from "react-hook-form";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

import { RequiredMark } from "./required-mark";

type TextareaProps = Omit<React.ComponentProps<typeof Textarea>, "id" | "name" | "value" | "defaultValue" | "onChange">;

type FormTextareaProps<T extends FieldValues> = TextareaProps & {
  readonly control: Control<T>;
  readonly name: FieldPath<T>;
  readonly label: string;
  readonly description?: string;
  /** Marks the label with an asterisk and the control with aria-required. */
  readonly required?: boolean;
};

export function FormTextarea<T extends FieldValues>({
  control,
  name,
  label,
  description,
  required,
  ...textareaProps
}: FormTextareaProps<T>) {
  const id = useId();

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field className="gap-1.5" data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={id}>
            {label}
            {required && <RequiredMark />}
          </FieldLabel>
          <Textarea {...textareaProps} {...field} id={id} aria-invalid={fieldState.invalid} aria-required={required} />
          {description && !fieldState.invalid && <FieldDescription>{description}</FieldDescription>}
          <FieldError errors={[fieldState.error]} />
        </Field>
      )}
    />
  );
}
