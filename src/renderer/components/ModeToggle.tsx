import type { TabMode } from '@shared/types.js';

const MODES: { value: TabMode; label: string }[] = [
  { value: 'web', label: 'Web' },
  { value: 'image', label: 'Image' },
  { value: 'ai', label: 'AI' },
];

export function ModeToggle({
  value,
  onChange,
}: {
  value: TabMode;
  onChange: (m: TabMode) => void;
}): JSX.Element {
  return (
    <div className="mode-toggle" role="radiogroup" aria-label="Search mode">
      {MODES.map((m) => (
        <button
          key={m.value}
          className={value === m.value ? 'on' : ''}
          onClick={() => onChange(m.value)}
          role="radio"
          aria-checked={value === m.value}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
