type AuthFieldProps = {
  id: string;
  label: string;
  name?: string;
  type?: string;
  value?: string;
  onChange?: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
  min?: number;
};

export function AuthField({
  id,
  label,
  name,
  type = "text",
  value,
  onChange,
  autoComplete,
  required = true,
  min,
}: AuthFieldProps) {
  const isControlled = value !== undefined && onChange !== undefined;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-300">
        {label}
        {!required ? (
          <span className="ml-1 font-normal text-gray-500">(optional)</span>
        ) : null}
      </label>
      <input
        id={id}
        name={name ?? id}
        type={type}
        {...(isControlled
          ? { value, onChange: (event) => onChange(event.target.value) }
          : {})}
        autoComplete={autoComplete}
        required={required}
        min={min}
        className="mt-2 w-full rounded-xl border border-gray-800 bg-black px-4 py-3 text-white outline-none transition placeholder:text-gray-500 focus:border-blue-600"
      />
    </div>
  );
}
