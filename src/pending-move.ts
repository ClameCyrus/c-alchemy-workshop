import { clone, makeDocument, stable, uid } from './core';
import { reviewSignature } from './change-summary';
import type { Entry, WorkDocument } from './types';

export interface PendingMove {
  source: string;
  target: string;
  lists: { unused: boolean; order: string[]; removed: { entry: Entry; fallbackId: string }[] }[];
  groups: { id: string; order: string[] }[];
}

export function captureMove(doc: WorkDocument, target: string, ids: string[]): PendingMove {
  const selected = new Set(ids);
  return {
    source: doc.ref.key,
    target,
    lists: [doc.entries, doc.unused].map((list, index) => ({
      unused: index === 1,
      order: list.map(entry => entry.id),
      removed: list.filter(entry => selected.has(entry.id)).map(entry => ({ entry: clone(entry), fallbackId: uid() })),
    })).filter(list => list.removed.length),
    groups: doc.state.groups.filter(group => group.members.some(id => selected.has(id)))
      .map(group => ({ id: group.id, order: [...group.members] })),
  };
}

function restorePosition<T>(list: T[], item: T, rank: number, order: string[], key: (item: T) => string) {
  for (let i = rank - 1; i >= 0; i--) {
    const before = list.findIndex(value => key(value) === order[i]);
    if (before !== -1) { list.splice(before + 1, 0, item); return; }
  }
  for (let i = rank + 1; i < order.length; i++) {
    const after = list.findIndex(value => key(value) === order[i]);
    if (after !== -1) { list.splice(after, 0, item); return; }
  }
  list.splice(Math.min(rank, list.length), 0, item);
}

export function restoreMove(doc: WorkDocument, move: PendingMove) {
  const ids = new Map<string, string>();
  for (const { unused, order, removed } of move.lists) {
    const list = unused ? doc.unused : doc.entries;
    for (const { entry, fallbackId } of removed) {
      const existing = [...doc.entries, ...doc.unused].find(value => value.id === entry.id);
      if (existing && stable(existing) === stable(entry)) continue;
      const restored = { ...clone(entry), id: existing ? fallbackId : entry.id };
      restorePosition(list, restored, order.indexOf(entry.id), order.map(id => ids.get(id) ?? id), value => value.id);
      ids.set(entry.id, restored.id);
    }
  }
  for (const { id, order } of move.groups) {
    const group = doc.state.groups.find(group => group.id === id);
    if (!group) continue;
    for (const [rank, member] of order.entries()) {
      const restored = ids.get(member);
      if (restored) restorePosition(group.members, restored, rank, order.map(id => ids.get(id) ?? id), value => value);
    }
  }
  const baseline = makeDocument(doc.ref, doc.snapshot);
  doc.dirty = reviewSignature([doc]) !== reviewSignature([baseline]);
}
