"use client";

import { useId } from "react";

import { type Control, Controller, type FieldPath, type FieldValues } from "react-hook-form";

import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import { RequiredMark } from "./required-mark";

type FormRadioGroupProps<T extends FieldValues> = {
  readonly control: Control<T>;
  readonly name: FieldPath<T>;
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly description?: string;
  /** Marks the legend with an asterisk and the group with aria-required. */
  readonly required?: boolean;
};

// Uses fieldset/legend rather than a label, since a group of radios has no single
// control for a label to point at.
export function FormRadioGroup<T extends FieldValues>({
  control,
  name,
  label,
  options,
  description,
  required,
}: FormRadioGroupProps<T>) {
  const id = useId();

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldSet data-invalid={fieldState.invalid}>
          <FieldLegend variant="label">
            {label}
            {required && <RequiredMark />}
          </FieldLegend>
          {description && <FieldDescription>{description}</FieldDescription>}
          <RadioGroup
            name={field.name}
            value={field.value}
            onValueChange={field.onChange}
            onBlur={field.onBlur}
            aria-required={required}
          >
            {options.map((option) => (
              <Field key={option.value} orientation="horizontal">
                <RadioGroupItem id={`${id}-${option.value}`} value={option.value} aria-invalid={fieldState.invalid} />
                <FieldLabel htmlFor={`${id}-${option.value}`} className="font-normal">
                  {option.label}
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
          <FieldError errors={[fieldState.error]} />
        </FieldSet>
      )}
    />
  );
}
