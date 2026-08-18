import { HTTPException } from 'hono/http-exception';
import type { TodoTemplateInput } from '../schemas/todo.js';

export const validateTemplateItems = (items: TodoTemplateInput[]): void => {
  const byKey = new Map(items.map((item) => [item.key, item]));
  if (byKey.size !== items.length) {
    throw new HTTPException(400, { message: 'template item keys must be unique' });
  }

  for (const item of items) {
    if (item.parentKey === null) continue;
    const parent = byKey.get(item.parentKey);
    if (parent === undefined) {
      throw new HTTPException(400, { message: `parent template not found: ${item.parentKey}` });
    }
    if (parent.period !== item.period) {
      throw new HTTPException(400, { message: 'parent and child periods must match' });
    }
  }

  for (const item of items) {
    const visited = new Set<string>([item.key]);
    let parentKey = item.parentKey;
    while (parentKey !== null) {
      if (visited.has(parentKey)) {
        throw new HTTPException(400, { message: 'template hierarchy must not contain cycles' });
      }
      visited.add(parentKey);
      parentKey = byKey.get(parentKey)?.parentKey ?? null;
    }
  }
};
