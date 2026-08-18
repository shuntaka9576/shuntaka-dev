interface TreeItem {
  id: string;
  parentId: string | null;
}

export const collectDescendantIds = (items: TreeItem[], rootId: string): string[] => {
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (item.parentId === null) continue;
    const siblings = children.get(item.parentId) ?? [];
    siblings.push(item.id);
    children.set(item.parentId, siblings);
  }

  const result: string[] = [];
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    result.push(id);
    pending.push(...(children.get(id) ?? []));
  }
  return result;
};
