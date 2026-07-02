import { ProgressLink } from './ProgressLink';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  baseHref: string;
}

type PageItem = number | 'ellipsis';

function buildPageItems(currentPage: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const items: PageItem[] = [];
  const window = 2;
  const start = Math.max(2, currentPage - window);
  const end = Math.min(totalPages - 1, currentPage + window);

  items.push(1);
  if (start > 2) {
    items.push('ellipsis');
  }
  for (let p = start; p <= end; p += 1) {
    items.push(p);
  }
  if (end < totalPages - 1) {
    items.push('ellipsis');
  }
  items.push(totalPages);
  return items;
}

function hrefFor(baseHref: string, page: number): string {
  if (page === 1) return baseHref;
  const sep = baseHref.endsWith('/') ? '' : '/';
  return `${baseHref}${sep}page/${page}`;
}

export function Pagination({ currentPage, totalPages, baseHref }: PaginationProps) {
  if (totalPages <= 1) return null;

  const items = buildPageItems(currentPage, totalPages);

  return (
    <nav className="mt-6 flex items-center justify-center text-sm sm:mt-8" aria-label="pagination">
      <ul className="flex items-center gap-1 sm:gap-2">
        {items.map((item, idx) =>
          item === 'ellipsis' ? (
            <li
              key={`ellipsis-${idx}`}
              className="px-1 text-[var(--color-text-muted)] sm:px-2"
              aria-hidden="true"
            >
              …
            </li>
          ) : item === currentPage ? (
            <li key={item}>
              <span
                aria-current="page"
                className="inline-flex min-h-10 min-w-10 items-center justify-center border-b-2 border-[var(--color-text)] px-2 font-medium text-[var(--color-text)] sm:px-3"
              >
                {item}
              </span>
            </li>
          ) : (
            <li key={item}>
              <ProgressLink
                href={hrefFor(baseHref, item)}
                className="inline-flex min-h-10 min-w-10 items-center justify-center px-2 text-[var(--color-link)] hover:text-[var(--color-link-hover)] sm:px-3"
                aria-label={`page ${item}`}
              >
                {item}
              </ProgressLink>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}
