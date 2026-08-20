"use client";

import { useId } from "react";

import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { type Control, Controller, type FieldPath, type FieldValues } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { RequiredMark } from "./required-mark";

type FormDatePickerProps<T extends FieldValues> = {
  readonly control: Control<T>;
  readonly name: FieldPath<T>;
  readonly label: string;
  readonly placeholder?: string;
  readonly description?: string;
  /** Marks the label with an asterisk and the control with aria-required. */
  readonly required?: boolean;
};

export function FormDatePicker<T extends FieldValues>({
  control,
  name,
  label,
  placeholder = "Pick a date",
  description,
  required,
}: FormDatePickerProps<T>) {
  const id = useId();

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        // field.value is a generic PathValue, which instanceof cannot narrow directly.
        const raw: unknown = field.value;
        const value = raw instanceof Date ? raw : undefined;

        return (
          <Field className="gap-1.5" data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={id}>
              {label}
              {required && <RequiredMark />}
            </FieldLabel>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  id={id}
                  type="button"
                  variant="outline"
                  aria-invalid={fieldState.invalid}
                  aria-required={required}
                  className={cn("w-full justify-start font-normal", !value && "text-muted-foreground")}
                >
                  <CalendarIcon data-icon="inline-start" />
                  {value ? format(value, "PPP") : placeholder}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={value} onSelect={field.onChange} />
              </PopoverContent>
            </Popover>
            {description && !fieldState.invalid && <FieldDescription>{description}</FieldDescription>}
            <FieldError errors={[fieldState.error]} />
          </Field>
        );
      }}
    />
  );
}
