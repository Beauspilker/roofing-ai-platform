type LeadFormFieldProps = {
  id: string;
  label: string;
  name?: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  placeholder?: string;
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
};

export function LeadFormField({
  id,
  label,
  name,
  type = "text",
  required = false,
  autoComplete,
  placeholder,
  defaultValue = "",
  value,
  onChange,
}: LeadFormFieldProps) {
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
        required={required}
        autoComplete={autoComplete}
        placeholder={placeholder}
        {...(isControlled
          ? { value, onChange: (event) => onChange(event.target.value) }
          : { defaultValue })}
        className="mt-2 w-full rounded-xl border border-gray-800 bg-black px-4 py-3 text-white outline-none transition placeholder:text-gray-500 focus:border-blue-600"
      />
    </div>
  );
}

type LeadFormSelectProps = {
  id: string;
  label: string;
  name?: string;
  required?: boolean;
  defaultValue?: string;
  options: { value: string; label: string }[];
  onChange?: (value: string) => void;
};

export function LeadFormSelect({
  id,
  label,
  name,
  required = false,
  defaultValue,
  options,
  onChange,
}: LeadFormSelectProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-300">
        {label}
        {!required ? (
          <span className="ml-1 font-normal text-gray-500">(optional)</span>
        ) : null}
      </label>
      <select
        id={id}
        name={name ?? id}
        required={required}
        defaultValue={defaultValue}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        className="mt-2 w-full rounded-xl border border-gray-800 bg-black px-4 py-3 text-white outline-none transition focus:border-blue-600"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

type LeadFormTextareaProps = {
  id: string;
  label: string;
  name?: string;
  rows?: number;
  defaultValue?: string;
};

export function LeadFormTextarea({
  id,
  label,
  name,
  rows = 4,
  defaultValue = "",
}: LeadFormTextareaProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-300">
        {label}
        <span className="ml-1 font-normal text-gray-500">(optional)</span>
      </label>
      <textarea
        id={id}
        name={name ?? id}
        rows={rows}
        defaultValue={defaultValue}
        className="mt-2 w-full rounded-xl border border-gray-800 bg-black px-4 py-3 text-white outline-none transition placeholder:text-gray-500 focus:border-blue-600"
      />
    </div>
  );
}

type LeadFormCheckboxProps = {
  id: string;
  label: string;
  name: string;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
};

export function LeadFormCheckbox({
  id,
  label,
  name,
  defaultChecked = false,
  onChange,
}: LeadFormCheckboxProps) {
  return (
    <label
      htmlFor={id}
      className="flex items-start gap-3 rounded-xl border border-gray-800 bg-black px-4 py-3"
    >
      <input
        id={id}
        name={name}
        type="checkbox"
        defaultChecked={defaultChecked}
        onChange={
          onChange ? (event) => onChange(event.target.checked) : undefined
        }
        className="mt-1 h-4 w-4 rounded border-gray-700 bg-black text-blue-600 focus:ring-blue-600"
      />
      <span className="text-sm text-gray-300">{label}</span>
    </label>
  );
}
