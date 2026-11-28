import { settingDifferences } from './entry-settings';
import type { Entry, Side } from './types';

export const differenceFilters = {
  content: '正文不同', enabled: '开关不同', name: '名称不同', settings: '设置不同', ambiguous: '待配对',
};
interface Change {
  type: keyof typeof differenceFilters | 'only-left' | 'only-right';
  label: string;
}
interface ComparisonRow {
  peer?: Entry;
  changes: Change[];
}

const body = (e: Entry) => e.content.replace(/\r\n/g, '\n');

function changesBetween(left: Entry, right: Entry) {
  const changes: Change[] = [];
  if (body(left) !== body(right)) changes.push({ type: 'content', label: differenceFilters.content });
  if (left.name !== right.name) changes.push({ type: 'name', label: differenceFilters.name });
  if (left.enabled !== right.enabled) changes.push({ type: 'enabled', label: differenceFilters.enabled });
  const settings = settingDifferences(left, right).filter(change => change.key !== 'enabled').map(change => change.label);
  if (settings.length) changes.push({ type: 'settings', label: settings.length === 1 ? settings[0] + '不同' : `设置 ${settings.length} 项不同` });
  return changes;
}

function buckets(entries: Set<Entry>, keyOf: (entry: Entry) => string) {
  const index = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!key) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(entry);
    else index.set(key, [entry]);
  }
  return index;
}

export function compareLists(left: Entry[], right: Entry[]) {
  const rows = { left: new Map<string, ComparisonRow>(), right: new Map<string, ComparisonRow>() };
  const remaining = { left: new Set(left), right: new Set(right) };
  const byName = (entry: Entry) => entry.name.trim();
  const byBody = (entry: Entry) =>
    entry.role === 'regex' && !entry.raw.findRegex && !entry.raw.replaceString ? '' : body(entry).trim();
  // Reserve shared IDs first. Only pair a fallback key when it is unique on both sides.
  for (const keyOf of [(entry: Entry) => entry.id, byName, byBody, byName]) {
    if (!remaining.left.size || !remaining.right.size) break;
    const a = buckets(remaining.left, keyOf), b = buckets(remaining.right, keyOf);
    for (const [key, candidates] of a) {
      const others = b.get(key);
      if (candidates.length !== 1 || others?.length !== 1) continue;
      const source = candidates[0], target = others[0];
      const changes = changesBetween(source, target);
      rows.left.set(source.id, { peer: target, changes });
      rows.right.set(target.id, { peer: source, changes });
      remaining.left.delete(source);
      remaining.right.delete(target);
    }
  }
  for (const side of ['left', 'right'] as Side[]) {
    const other = remaining[side === 'left' ? 'right' : 'left'];
    const names = buckets(other, byName), bodies = buckets(other, byBody);
    for (const entry of remaining[side]) {
      const change: Change = names.has(byName(entry)) || bodies.has(byBody(entry))
        ? { type: 'ambiguous', label: differenceFilters.ambiguous }
        : side === 'left' ? { type: 'only-left', label: '仅来源' } : { type: 'only-right', label: '仅目标' };
      rows[side].set(entry.id, { changes: [change] });
    }
  }
  return rows;
}

export function matchesOverview(row: ComparisonRow, filter: string) {
  if (filter === 'all' || filter === 'disabled') return true;
  if (filter === 'exact') return row.changes.length === 0;
  if (filter === 'different') return row.changes.some(change => change.type !== 'ambiguous');
  return row.changes.some(change => change.type === filter);
}
