import { normalizeGroups, orderOf } from './core';
import { nativeGrouping } from './group-runtime';
import type { Group, Resource, Snapshot } from './types';

export interface NativeEntry { id: string; name: string; enabled: boolean }
export interface NativeModel { ref: Resource; groups: Group[]; entries: NativeEntry[] }
export function nativeModel(ref: Resource, snapshot: Snapshot): NativeModel | undefined {
  const own = snapshot.own;
  if (!nativeGrouping(own)) return;
  const entries: NativeEntry[] = ref.kind === 'regex'
    ? snapshot.raw.map((r: any) => ({ id: String(r.id), name: String(r.scriptName || '未命名正则'), enabled: !r.disabled }))
    : (() => {
      const prompts = new Map((snapshot.raw.prompts || []).map((p: any) => [String(p.identifier), p]));
      return orderOf(snapshot.raw).filter(o => prompts.has(String(o.identifier))).map(o => {
        const p: any = prompts.get(String(o.identifier));
        return { id: String(o.identifier), name: String(p.name || '未命名条目'), enabled: o.enabled !== false };
      });
    })();
  if (new Set(entries.map(e => e.id)).size !== entries.length) throw new Error('原生列表含重复ID，已停止分组接管');
  const groups = normalizeGroups(own.groups || [], entries.map(e => e.id)).filter(g => g.members.length);
  return groups.length ? { ref, entries, groups } : undefined;
}
