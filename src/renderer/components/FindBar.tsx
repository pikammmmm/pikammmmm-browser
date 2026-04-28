import { useEffect, useRef } from 'react';
import { useApp } from '../state.js';

export function FindBar(): JSX.Element | null {
  const find = useApp((s) => s.find);
  const setFindText = useApp((s) => s.setFindText);
  const closeFind = useApp((s) => s.closeFind);
  const findStep = useApp((s) => s.findStep);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (find.open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [find.open]);

  if (!find.open) return null;

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        value={find.text}
        onChange={(e) => setFindText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeFind();
          else if (e.key === 'Enter') findStep(!e.shiftKey);
        }}
        placeholder="Find in page"
      />
      <span className="count">
        {find.text ? `${find.active}/${find.total}` : ''}
      </span>
      <button onClick={() => findStep(false)} title="Previous (Shift+Enter)">
        ‹
      </button>
      <button onClick={() => findStep(true)} title="Next (Enter)">
        ›
      </button>
      <button onClick={closeFind} title="Close (Esc)">
        ×
      </button>
    </div>
  );
}
