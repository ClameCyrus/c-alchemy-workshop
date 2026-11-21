import { clone, uid } from './core';
import type { Provider, Raw, WorkDocument } from './types';

type Scheme = 'own' | Provider;
export interface ImportGroup { id: string; name: string; schemes: Scheme[]; label: string }

export function importGroups(doc: WorkDocument): ImportGroup[] {
  if (doc.snapshot.legacyOwn) return [];
  const choices: ImportGroup[] = [];
  for (const source of doc.sources) {
    if (source.provider === 'legacy') continue;
    const scheme = source.provider;
    if (scheme !== 'own' && doc.state.suppressed.includes(scheme)) continue;
    for (const group of source.groups) {
      const synced = scheme !== 'own' && doc.state.sync.includes(scheme)
        && choices.find(item => item.schemes.includes('own') && item.id === group.id && item.name === group.name);
      if (synced) synced.schemes.push(scheme);
      else choices.push({ id: group.id, name: group.name, label: source.label, schemes: [scheme] });
    }
  }
  return choices;
}

// The transfer tool shares its group list across presets and characters.
export function appendTransferMembers(store: any, scope: string, id: string, ids: string[]) {
  const next = clone(store);
  const rows: Raw[] = Array.isArray(next) ? next : next?.groups || [];
  const matches = rows.filter(row => row.id === id && (row.scope || 'global') === scope);
  if (matches.length !== 1) throw new Error('目标分组已变化，请重新选择');
  const group = matches[0];
  group.memberIds = [...new Set([...(group.memberIds || group.members || []), ...ids])];
  return next;
}

export function groupedRegexSnapshot(doc: WorkDocument, scripts: Raw[], choice: ImportGroup) {
  const match = importGroups(doc).find(item => item.id === choice.id && item.name === choice.name &&
    item.schemes.join() === choice.schemes.join());
  if (!match) throw new Error('目标分组已变化，请重新选择');
  const snapshot = clone(doc.snapshot);
  const added = scripts.map(script => ({ ...script, id: uid() }));
  const ids = added.map(script => script.id);
  const source = doc.sources.find(plan => plan.provider === match.schemes[0]);
  const members = new Set(source?.groups.find(group => group.id === match.id)?.members);
  // Older imports may have left a detached member at the bottom of the execution list.
  // Append to the first contiguous section without moving existing rules.
  const first = snapshot.raw.findIndex((script: Raw) => members.has(String(script.id)));
  let position = first < 0 ? snapshot.raw.length : first;
  while (position < snapshot.raw.length && members.has(String(snapshot.raw[position].id))) position++;
  snapshot.raw = [...snapshot.raw.slice(0, position), ...added, ...snapshot.raw.slice(position)];
  for (const scheme of match.schemes) {
    if (scheme === 'own') {
      snapshot.own.groups.find((group: Raw) => group.id === match.id).members.push(...ids);
    } else if (scheme === 'baibai') {
      const memberships = snapshot.baibai.scripts ||= {};
      const orders = Object.values<Raw>(memberships).filter(item => item.groupId === match.id);
      let order = orders.reduce((max, item) => Math.max(max, Number(item.order) || 0), -1);
      for (const id of ids) memberships[id] = { groupId: match.id, order: ++order };
    } else {
      snapshot.transfer = appendTransferMembers(snapshot.transfer, doc.ref.scope, match.id, ids);
    }
  }
  doc.regexImport = { ids, baibai: match.schemes.includes('baibai'), transferGroup: match.schemes.includes('transfer') ? match.id : undefined };
  return snapshot;
}
