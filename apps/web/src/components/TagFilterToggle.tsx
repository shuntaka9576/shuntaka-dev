'use client';

interface TagFilterToggleProps {
  open: boolean;
  /** 絞り込み中（パネルが閉じていても選択状態を示す） */
  active: boolean;
  onClick: () => void;
  panelId: string;
}

export function TagFilterToggle({ open, active, onClick, panelId }: TagFilterToggleProps) {
  const emphasized = open || active;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-controls={panelId}
      className={`inline-flex items-center gap-1 text-[length:var(--fs-caption)] ${
        emphasized ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
      }`}
    >
      {/* タグアイコン（Lucide "tag" 相当、stroke 1.5px・塗りなし） */}
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
        <circle cx="7.5" cy="7.5" r="0.5" fill="currentColor" />
      </svg>
      tags
    </button>
  );
}
