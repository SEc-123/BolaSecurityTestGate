import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  help?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, help, className = '', ...props }, ref) => (
    <div className="mb-4">
      {label && <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">{label}</label>}
      <input
        ref={ref}
        className={`h-9 w-full rounded border bg-white px-3 text-sm text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-slate-950 focus:ring-0 ${
          error ? 'border-red-500' : 'border-slate-300'
        } ${className}`}
        {...props}
      />
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
      {!error && help && <p className="mt-1 text-xs text-slate-500">{help}</p>}
    </div>
  )
);

Input.displayName = 'Input';

interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  help?: string;
}

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ label, error, help, className = '', ...props }, ref) => (
    <div className="mb-4">
      {label && <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">{label}</label>}
      <textarea
        ref={ref}
        className={`w-full rounded border bg-white px-3 py-2 text-sm text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-slate-950 focus:ring-0 ${
          error ? 'border-red-500' : 'border-slate-300'
        } ${className}`}
        {...props}
      />
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
      {!error && help && <p className="mt-1 text-xs text-slate-500">{help}</p>}
    </div>
  )
);

TextArea.displayName = 'TextArea';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options?: { value: string; label: string }[];
  help?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options = [], help, className = '', ...props }, ref) => (
    <div className="mb-4">
      {label && <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">{label}</label>}
      <select
        ref={ref}
        className={`h-9 w-full rounded border bg-white px-3 text-sm text-slate-950 outline-none transition-colors focus:border-slate-950 focus:ring-0 ${
          error ? 'border-red-500' : 'border-slate-300'
        } ${className}`}
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
      {!error && help && <p className="mt-1 text-xs text-slate-500">{help}</p>}
    </div>
  )
);

Select.displayName = 'Select';

interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, className = '', ...props }, ref) => (
    <div className="mb-4 flex items-center">
      <input
        ref={ref}
        type="checkbox"
        className={`h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-950 ${className}`}
        {...props}
      />
      {label && <label className="ml-2 text-sm text-slate-700">{label}</label>}
    </div>
  )
);

Checkbox.displayName = 'Checkbox';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

const variantClasses = {
  primary: 'bg-[#1268d6] text-white hover:bg-[#0d57b7]',
  secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  outline: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
};

const sizeClasses = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-9 px-4 text-sm',
  lg: 'h-10 px-5 text-base',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading = false, children, className = '', ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center rounded font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? (
        <span className="flex items-center gap-2">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"></span>
          Working
        </span>
      ) : (
        children
      )}
    </button>
  )
);

Button.displayName = 'Button';
