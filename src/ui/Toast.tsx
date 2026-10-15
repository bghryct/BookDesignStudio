import React from 'react';
import clsx from 'clsx';
import { useStore } from '../store/store';

export function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div
      role="status"
      className={clsx(
        'pointer-events-none fixed bottom-10 left-1/2 z-[100] max-w-[min(560px,90vw)] -translate-x-1/2 rounded-md px-3.5 py-2 text-[12px] shadow-2xl',
        toast.kind === 'error' ? 'bg-[#7a2618] text-white' : 'bg-ink-100 text-ink-900',
      )}
    >
      {toast.text}
    </div>
  );
}
