export const NULL_TOKEN = '\\N';
export const FIELD_SEP = '\t';
export const ROW_SEP = '\n';

const ESC_RE = /[\\\t\n\r]/g;

function replaceEscape(c: string): string {
  if (c === '\\') return '\\\\';
  if (c === '\t') return '\\t';
  if (c === '\n') return '\\n';
  return '\\r';
}

export function escapePgText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return NULL_TOKEN;
  const str = typeof value === 'number' ? String(value) : value;
  return str.replace(ESC_RE, replaceEscape);
}

export function toRow(fields: (string | number | null | undefined)[]): string {
  return `${fields.map(escapePgText).join(FIELD_SEP)}${ROW_SEP}`;
}
