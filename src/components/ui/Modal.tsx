import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  footer?: React.ReactNode;
  actions?: React.ReactNode;
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  '2xl': 'max-w-5xl',
  full: 'max-w-7xl',
};

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  footer,
  actions,
}: ModalProps) {
  if (!isOpen) return null;

  const footerContent = footer ?? actions;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-slate-950/55 backdrop-blur-[1px] transition-opacity"
        onClick={onClose}
      ></div>

      <div
        className={`relative z-50 mx-4 w-full rounded border border-slate-200 bg-white shadow-2xl ${sizeClasses[size]}`}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-950">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950"
          >
            <X size={20} />
          </button>
        </div>

        <div className="max-h-[72vh] overflow-y-auto px-5 py-5">{children}</div>

        {footerContent && (
          <div className="flex items-center justify-end gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4">
            {footerContent}
          </div>
        )}
      </div>
    </div>
  );
}
