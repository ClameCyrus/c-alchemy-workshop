import type { WorkDocument } from './types';

/** Move a complete group as one block, preserving members, flags, IDs and raw fields. */
export function reorderGroup(doc: WorkDocument, groupId: string, targetId?: string, after = false) {
  const group = doc.state.groups.find(g => g.id === groupId);
  if (!group) throw new Error('分组已不存在，请重试');
  const members = new Set(group.members), moved = doc.entries.filter(e => members.has(e.id));
  if (!moved.length) throw new Error('分组已没有可排序条目');
  if (targetId && members.has(targetId)) return false;
  if (targetId && !doc.entries.some(e => e.id === targetId)) throw new Error('目标条目已不存在，请重试');
  const targetGroup = doc.state.groups.find(g => g.members.includes(targetId || ''));
  if (targetGroup) {
    const targets = doc.entries.filter(e => targetGroup.members.includes(e.id));
    targetId = (after ? targets.at(-1) : targets[0])?.id;
  }
  const rest = doc.entries.filter(e => !members.has(e.id));
  const index = targetId ? rest.findIndex(e => e.id === targetId) + Number(after) : rest.length;
  rest.splice(index, 0, ...moved);
  if (rest.every((e, i) => e === doc.entries[i])) return false;
  doc.entries = rest; doc.dirty = true;
  return true;
}
