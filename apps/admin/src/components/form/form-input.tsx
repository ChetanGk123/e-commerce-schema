"use client";

import type * as React from "react";
import { useId, useState } from "react";

import { Eye, EyeOff } from "lucide-react";
import { type Control, Controller, type FieldPath, type FieldValues } from "react-hook-form";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";

import { RequiredMark } from "./required-mark";

// react-hook-form owns value/onChange/onBlur/name, so callers cannot pass them.
type InputProps = Omit<React.ComponentProps<typeof Input>, "id" | "name" | "value" | "defaultValue" | "onChange">;

type FormInputProps<T extends FieldValues> = InputProps & {
  readonly control: Control<T>;
  readonly name: FieldPath<T>;
  readonly label: string;
  /** Hint shown under the input. Replaced by the validation message when invalid. */
  readonly description?: string;
  /** Rendered opposite the label, e.g. a "Forgot password?" link. */
  readonly labelAction?: React.ReactNode;
  /** Marks the label with an asterisk and the control with aria-required. */
  readonly required?: boolean;
};

export function FormInput<T extends FieldValues>({
  control,
  name,
  label,
  description,
  labelAction,
  required,
  ...inputProps
}: FormInputProps<T>) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const isNumber = inputProps.type === "number";
  const isPassword = inputProps.type === "password";

  const renderLabel = () => (
    <FieldLabel htmlFor={id}>
      {label}
      {required && <RequiredMark />}
    </FieldLabel>
  );

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const controlProps = {
          ...inputProps,
          ...field,
          id,
          "aria-invalid": fieldState.invalid,
          "aria-required": required,
          // An empty number input reports "", which Number() would turn into 0.
          value: field.value ?? "",
          onChange: isNumber
            ? (event: React.ChangeEvent<HTMLInputElement>) =>
                field.onChange(event.target.value === "" ? undefined : event.target.valueAsNumber)
            : field.onChange,
          onFocus: (event: React.FocusEvent<HTMLInputElement>) => {
            // Selecting on focus makes a number field replaceable in one keystroke.
            if (isNumber) event.currentTarget.select();
            inputProps.onFocus?.(event);
          },
        };

        return (
          <Field className="gap-1.5" data-invalid={fieldState.invalid}>
            {labelAction ? (
              <div className="flex items-center justify-between gap-2">
                {renderLabel()}
                {labelAction}
              </div>
            ) : (
              renderLabel()
            )}
            {isPassword ? (
              <InputGroup>
                <InputGroupInput {...controlProps} type={revealed ? "text" : "password"} />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    aria-label={revealed ? "Hide password" : "Show password"}
                    aria-pressed={revealed}
                    // Revealing is a display toggle, so the value is never re-keyed.
                    onClick={() => setRevealed((current) => !current)}
                  >
                    {revealed ? <EyeOff /> : <Eye />}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            ) : (
              <Input {...controlProps} />
            )}
            {description && !fieldState.invalid && <FieldDescription>{description}</FieldDescription>}
            {/* FieldError renders nothing when there is no error, so it needs no guard. */}
            <FieldError errors={[fieldState.error]} />
          </Field>
        );
      }}
    />
  );
}
