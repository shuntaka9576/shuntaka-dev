'use client';

import { useId, type KeyboardEvent } from 'react';

export interface SearchInputProps {
  /** 現在の入力値（controlled） */
  value: string;
  /** 入力変化のたびに呼ばれる。呼び出し側で debounce する */
  onChange: (next: string) => void;
  /** クリアボタンまたは Escape 押下時に呼ばれる */
  onClear: () => void;
  /** Enter 押下時に呼ばれる。debounce をキャンセルして即座に検索したいケース向け */
  onSubmit?: () => void;
  /** true のとき input に aria-busy を付ける */
  loading?: boolean;
  /** 表示上のプレースホルダー */
  placeholder?: string;
  /** aria-label（省略時はプレースホルダーを流用） */
  ariaLabel?: string;
  /** マウント時に focus を当てるか（フローティングパネル open 時に true） */
  autoFocus?: boolean;
}

/** Lucide "search" 相当（stroke 1.5px、塗りなし） */
function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

/** Lucide "x" 相当（stroke 1.5px、塗りなし） */
function ClearIcon() {
  return (
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
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/**
 * セマンティック検索の入力ボックス。表示状態のみを持つ props ベースの pure component。
 * debounce や URL 同期は呼び出し側（SearchProvider）で行う。
 */
export function SearchInput({
  value,
  onChange,
  onClear,
  onSubmit,
  loading,
  placeholder = '気になることを日本語で…',
  ariaLabel,
  autoFocus,
}: SearchInputProps) {
  const inputId = useId();

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && value) {
      // input 側で clear を吸収するため、親（FloatingSearchTagFilter の
      // document keydown ハンドラ）まで Escape を伝播させない。
      // これにより「1 回目 = クリア、2 回目 = パネル閉じ」の 2 段挙動が成立する
      event.preventDefault();
      event.stopPropagation();
      onClear();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onSubmit?.();
    }
  };

  return (
    <div
      role="search"
      className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 focus-within:border-[var(--color-text)]"
    >
      <span className="text-[var(--color-text-muted)]" aria-hidden="true">
        <SearchIcon />
      </span>
      <input
        id={inputId}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        aria-busy={loading || undefined}
        // biome-ignore lint/a11y/noAutofocus: フローティングパネル open 時のみ true（明示 opt-in）
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        className="w-full min-w-0 flex-1 border-0 bg-transparent text-[length:var(--fs-body)] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
      />
      {value && (
        <button
          type="button"
          onClick={onClear}
          aria-label="検索をクリア"
          className="text-[var(--color-text-muted)]"
        >
          <ClearIcon />
        </button>
      )}
    </div>
  );
}
