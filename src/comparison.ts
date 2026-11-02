import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { settingsOf, stable } from './core';
import type { Entry, Match, WorkDocument } from './types';

interface Input {
  left?: WorkDocument; right?: WorkDocument; anchor?: Entry; anchorKey?: string;
  unused: boolean; filter: string; enabled: boolean; threshold: number;
}
const entries = (doc: WorkDocument | undefined, unused: boolean) =>
  doc ? [...doc.entries, ...(unused ? doc.unused : [])] : [];

export function useComparison(read: () => Input, signature: (entry: Entry) => string,
  compare: (a: Entry, b: Entry) => Match | null) {
  const relations = shallowRef(new Map<string, Match>());
  const exact = shallowRef({ left: new Set<string>(), right: new Set<string>() });
  const related = shallowRef({ left: new Set<string>(), right: new Set<string>() });
  const working = ref(false);
  let version = 0;
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  watch(() => {
    const input = read();
    const left = entries(input.left, input.unused), right = entries(input.right, input.unused);
    return { ...input, leftRows: left, rightRows: right,
      fingerprint: [...left, ...right].map(signature).join('\0') };
  }, async input => {
    const job = ++version;
    relations.value = new Map();
    related.value = { left: new Set(), right: new Set() };
    const left = input.leftRows, right = input.rightRows;
    const exactResult = { left: new Set<string>(), right: new Set<string>() };
    // Exact equality needs no fuzzy comparison or n*m scan.
    const buckets = new Map<string, Entry[]>();
    const key = (e: Entry) => e.content.replace(/\r\n/g, '\n').trim() + '\0' + stable(settingsOf(e));
    for (const b of right) { const k = key(b); const bucket = buckets.get(k) || []; bucket.push(b); buckets.set(k, bucket); }
    for (const a of left) {
      const matches = buckets.get(key(a)) || [];
      for (const b of matches) {
        if (!a.content.trim() && a.id !== b.id && a.name !== b.name) continue;
        exactResult.left.add(a.id); exactResult.right.add(b.id);
      }
    }
    exact.value = exactResult;
    if (!input.enabled) { working.value = false; return; }
    const needsPairs = ['different', 'only-left', 'only-right'].includes(input.filter);
    working.value = !!input.anchor || needsPairs;
    if (!working.value) return;
    const relationResult = new Map<string, Match>();
    const any = { left: new Set(exactResult.left), right: new Set(exactResult.right) };
    let deadline = performance.now() + 8;
    await pause();
    if (job !== version) return;
    if (input.anchor) {
      const candidates = input.anchorKey === input.left?.ref.key ? right : left;
      for (const candidate of candidates) {
        const match = compare(input.anchor, candidate);
        if (match) relationResult.set(candidate.id, match);
        if (performance.now() >= deadline) {
          await pause(); if (job !== version) return; deadline = performance.now() + 8;
        }
      }
    }
    if (needsPairs) {
      for (const a of left) for (const b of right) {
        if (any.left.has(a.id) && any.right.has(b.id)) continue;
        if (compare(a, b)) { any.left.add(a.id); any.right.add(b.id); }
        if (performance.now() >= deadline) {
          await pause(); if (job !== version) return; deadline = performance.now() + 8;
        }
      }
    }
    if (job !== version) return;
    relations.value = relationResult;
    related.value = any;
    working.value = false;
  }, { immediate: true });
  onBeforeUnmount(() => { version++; });
  return { relations, exact, related, working };
}
