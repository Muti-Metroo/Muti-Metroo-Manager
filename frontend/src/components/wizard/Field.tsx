export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="wizard-field">
      <span className="font-semibold">{label}</span>
      {children}
      {hint && !error && <span className="text-muted text-xs">{hint}</span>}
      {error && <span className="text-error text-xs">{error}</span>}
    </label>
  );
}
