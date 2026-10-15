import React from 'react';
import clsx from 'clsx';
import { useStore, type RightTab } from '../../store/store';
import { ElementPanel } from './ElementPanel';
import { TypePanel } from './TypePanel';
import { DocumentPanel } from './DocumentPanel';
import { BindingPanel } from './BindingPanel';
import { FontsPanel } from './FontsPanel';

const TABS: { id: RightTab; label: string }[] = [
  { id: 'element', label: 'Item' },
  { id: 'type', label: 'Type' },
  { id: 'document', label: 'Document' },
  { id: 'binding', label: 'Binding' },
  { id: 'fonts', label: 'Fonts' },
];

export function RightPanel() {
  const tab = useStore((s) => s.rightTab);
  return (
    <aside className="flex w-[296px] shrink-0 flex-col border-l border-ink-700 bg-ink-850">
      <div className="flex h-9 shrink-0 items-end gap-0.5 border-b border-ink-700 px-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => useStore.getState().setRightTab(t.id)}
            className={clsx('h-8 rounded-t px-2 text-[11.5px]', tab === t.id ? 'border-x border-t border-ink-700 bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-200')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {tab === 'element' && <ElementPanel />}
        {tab === 'type' && <TypePanel />}
        {tab === 'document' && <DocumentPanel />}
        {tab === 'binding' && <BindingPanel />}
        {tab === 'fonts' && <FontsPanel />}
      </div>
    </aside>
  );
}
