"use client";

import { useId } from "react";

import { type Control, Controller, type FieldPath, type FieldValues } from "react-hook-form";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

import { RequiredMark } from "./required-mark";

type FormOTPProps<T extends FieldValues> = {
  readonly control: Control<T>;
  readonly name: FieldPath<T>;
  readonly label: string;
  readonly length?: number;
  readonly description?: string;
  /** Marks the label with an asterisk and the control with aria-required. */
  readonly required?: boolean;
};

export function FormOTP<T extends FieldValues>({
  control,
  name,
  label,
  length = 6,
  description,
  required,
}: FormOTPProps<T>) {
  const id = useId();
  const slots = Array.from({ length }, (_, index) => index);

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
          <InputOTP
            id={id}
            maxLength={length}
            value={field.value ?? ""}
            onChange={field.onChange}
            onBlur={field.onBlur}
            aria-invalid={fieldState.invalid}
            aria-required={required}
          >
            <InputOTPGroup>
              {slots.map((slot) => (
                <InputOTPSlot key={`${id}-slot-${slot}`} index={slot} />
              ))}
            </InputOTPGroup>
          </InputOTP>
          {description && !fieldState.invalid && <FieldDescription>{description}</FieldDescription>}
          <FieldError errors={[fieldState.error]} />
        </Field>
      )}
    />
  );
}
