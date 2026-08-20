/**
 * Visual required indicator. Hidden from assistive tech — the control carries
 * `aria-required`, so a screen reader announcing "star" would be a second,
 * noisier telling of the same thing.
 */
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="text-destructive">
      *
    </span>
  );
}
