import type { TodoDashboard, TodoPeriod } from '@/entities/todo';

export interface ParsedTemplateItem {
  key: string;
  parentKey: string | null;
  period: TodoPeriod;
  title: string;
  position: number;
}

const headingPeriod = (line: string): TodoPeriod | null | undefined => {
  const match = line.match(/^#{1,6}\s*(.+?)\s*$/);
  if (match === null) return undefined;
  if (match[1] === '朝') return 'morning';
  if (match[1] === '寝る前') return 'bedtime';
  return null;
};

const indentation = (value: string): number => {
  let total = 0;
  for (const char of value) total += char === ' ' ? 1 : 2;
  return total;
};

export const parseChecklistMarkdown = (markdown: string): ParsedTemplateItem[] => {
  const result: ParsedTemplateItem[] = [];
  const stacks: Record<TodoPeriod, { indent: number; key: string }[]> = {
    morning: [],
    bedtime: [],
  };
  let period: TodoPeriod | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const detectedPeriod = headingPeriod(line.trim());
    if (detectedPeriod !== undefined) {
      period = detectedPeriod;
      continue;
    }
    if (period === null) continue;
    const bullet = line.match(/^([\t 　]*)(?:[-*・])\s*(.+?)\s*$/);
    const title = bullet?.[2];
    if (bullet === null || title === undefined || title === '') continue;
    const indent = indentation(bullet[1] ?? '');
    const stack = stacks[period];
    while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop();
    const key = `item-${result.length + 1}`;
    result.push({
      key,
      parentKey: stack.at(-1)?.key ?? null,
      period,
      title,
      position: result.length,
    });
    stack.push({ indent, key });
  }
  return result;
};

export const serializeChecklistMarkdown = (
  settings: NonNullable<TodoDashboard['settings']>,
): string => {
  const byParent = new Map<string | null, typeof settings.items>();
  for (const item of settings.items) {
    const siblings = byParent.get(item.parentKey) ?? [];
    siblings.push(item);
    byParent.set(item.parentKey, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.position - b.position);

  const lines: string[] = [];
  const append = (parentKey: string | null, period: TodoPeriod, depth: number): void => {
    for (const item of byParent.get(parentKey) ?? []) {
      if (item.period !== period) continue;
      lines.push(`${'  '.repeat(depth)}- ${item.title}`);
      append(item.key, period, depth + 1);
    }
  };
  for (const period of ['morning', 'bedtime'] as const) {
    if (lines.length > 0) lines.push('');
    lines.push(period === 'morning' ? '# 朝' : '# 寝る前');
    append(null, period, 0);
  }
  return lines.join('\n');
};
