import type { Entry, Group } from './types';
export type BrowseRow = { type: 'group'; key: string; group: Group; count: number; collapsed: boolean }
  | { type: 'entry'; key: string; entry: Entry };
// Preserve execution order; non-contiguous members get a header at each actual boundary.
export function browseRows(entries: Entry[], groups: Group[], folded: (id: string) => boolean, forceOpen = false): BrowseRow[] {
  const membership = new Map<string, Group>(), counts = new Map<string, number>();
  for (const group of groups) for (const id of group.members) if (!membership.has(id)) membership.set(id, group);
  for (const entry of entries) { const group = membership.get(entry.id); if (group) counts.set(group.id, (counts.get(group.id) || 0) + 1); }
  const rows: BrowseRow[] = []; let previous = '';
  for (const entry of entries) {
    const group = membership.get(entry.id), collapsed = !!group && !forceOpen && folded(group.id);
    if (group && group.id !== previous) rows.push({ type: 'group', key: `g:${group.id}:${entry.id}`, group, count: counts.get(group.id)!, collapsed });
    if (!collapsed) rows.push({ type: 'entry', key: `e:${entry.id}`, entry });
    previous = group?.id || '';
  }
  return rows;
}
