import { useEffect } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorAfter?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  useEffect(() => {
    const close = (): void => onClose();
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    // Defer attach so the click that opened the menu doesn't immediately close it.
    const t = setTimeout(() => {
      window.addEventListener('mousedown', close);
      window.addEventListener('keydown', esc);
      window.addEventListener('blur', close);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  return (
    <div
      className="ctx-menu"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => (
        <span key={i}>
          <button
            className={`ctx-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onClick();
              onClose();
            }}
          >
            {it.label}
          </button>
          {it.separatorAfter && <div className="ctx-sep" />}
        </span>
      ))}
    </div>
  );
}
