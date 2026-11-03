import { assignGroup, clone, makeDocument, normalizeGroups, rangeMembers, removeEntries, transferEntries, uid } from './core';
import { saveDocuments } from './native';
import type { GroupSource, Host, Provider, Resource, WorkDocument } from './types';

export interface QuickSource { ref: Resource; ids: string[] }
export interface GroupChoice { provider: 'own' | Provider; id: string }
export const sameResource = (a: Resource, b: Resource) => a.kind === b.kind && a.scope === b.scope &&
  (a.scope === 'preset' ? a.name === b.name : a.scope === 'scoped' ? a.avatar === b.avatar : true);

export class QuickOperations {
  constructor(private host: Host, private guard: (ref: Resource) => void = () => {}, private changed: (refs: Resource[]) => void = () => {}) {}
  targets(ref: Resource) {
    const rows = this.host.resources(ref.kind);
    return rows.filter(r => !rows.some(live => live.live && !r.live && sameResource(live, r)));
  }
  async load(ref: Resource) {
    const current = this.host.resources(ref.kind).find(r => r.key === ref.key);
    if (!current || !sameResource(current, ref)) throw new Error('当前预设或角色已切换，请重试');
    return makeDocument(ref, await this.host.load(ref));
  }
  plans(doc: WorkDocument): GroupSource[] {
    return [
      { provider: 'own', label: '工坊', groups: clone(doc.state.groups), raw: doc.snapshot.own },
      ...doc.sources.filter(s => s.provider !== 'own'),
    ];
  }
  private adopt(doc: WorkDocument, provider: GroupChoice['provider']) {
    const plan = this.plans(doc).find(p => p.provider === provider);
    if (!plan) throw new Error('分组方案已变更，请重试');
    doc.state.groups = normalizeGroups(clone(plan.groups), [...doc.entries, ...doc.unused].map(e => e.id));
    if (provider !== 'own') {
      doc.state.sync = [...new Set([...doc.state.sync, provider])];
      doc.state.suppressed = doc.state.suppressed.filter(p => p !== provider);
    }
  }
  private mirror(doc: WorkDocument, copied: { sourceId: string; id: string }[] = []) {
    // Keep conflicting third-party plans distinct until the user chooses one.
    const valid = new Set([...doc.entries, ...doc.unused].map(e => e.id));
    for (const source of doc.sources.filter(s => s.provider !== 'own')) {
      const groups = clone(source.groups);
      for (const group of groups) {
        group.members = group.members.filter(id => valid.has(id));
        for (const pair of copied) {
          const index = group.members.indexOf(pair.sourceId);
          if (index >= 0) group.members.splice(index + 1, 0, pair.id);
        }
      }
      doc.providerGroups ||= {};
      doc.providerGroups[source.provider as Provider] = groups;
    }
  }
  async transfer(sources: QuickSource[], targetRef: Resource, action: 'copy' | 'move', choice?: GroupChoice) {
    const loaded = new Map<string, WorkDocument>();
    const get = async (ref: Resource) => {
      const alias = [...loaded.values()].find(d => sameResource(d.ref, ref));
      if (alias) return alias;
      const doc = await this.load(ref); loaded.set(ref.key, doc); return doc;
    };
    const target = await get(targetRef);
    if (choice) {
      this.adopt(target, choice.provider);
      if (choice.id && !target.state.groups.some(g => g.id === choice.id)) throw new Error('分组已删除，请重新选择');
    }
    let position: string | undefined;
    if (choice?.id) {
      const members = new Set(target.state.groups.find(g => g.id === choice.id)!.members);
      position = target.entries.filter(e => members.has(e.id)).at(-1)?.id;
    } else if (!choice) {
      const localIds = new Set(sources.filter(s => sameResource(s.ref, targetRef)).flatMap(s => s.ids));
      position = target.entries.filter(e => localIds.has(e.id)).at(-1)?.id;
    }
    const added: string[] = [];
    for (const source of sources) {
      const doc = await get(source.ref);
      const ids = [...new Set(source.ids)];
      const originals = [...doc.entries, ...doc.unused].filter(e => ids.includes(e.id));
      if (originals.length !== ids.length) throw new Error('部分条目已不存在，请重新选择');
      const output = transferEntries(doc, target, ids, action, position, !!position, choice?.id || undefined);
      if (choice && !choice.id) assignGroup(target, output);
      if (action === 'copy' && doc === target && !choice)
        this.mirror(target, output.map((id, i) => ({ sourceId: originals[i].id, id })));
      if (action === 'move' && doc !== target) this.mirror(doc);
      if (output.length) position = output.at(-1);
      added.push(...output);
    }
    if (!added.length) return [];
    const dirty = [...loaded.values()].filter(d => d.dirty);
    dirty.forEach(d => this.guard(d.ref));
    await saveDocuments(this.host, dirty, [target.ref.key]);
    this.changed(dirty.map(d => d.ref));
    return added;
  }
  async group(ref: Resource, start: string, end: string, name: string, provider: GroupChoice['provider']) {
    if (!name.trim()) throw new Error('请输入组名');
    const doc = await this.load(ref);
    this.adopt(doc, provider);
    const ids = rangeMembers(doc, start, end), id = uid();
    doc.state.native = true;
    doc.state.groups.push({ id, name: name.trim(), members: [], collapsed: false, enabled: true });
    assignGroup(doc, ids, id);
    this.guard(ref);
    await saveDocuments(this.host, [doc]);
    this.changed([ref]);
    return ids.length;
  }
  async reorderRegex(ref: Resource, id: string, beforeId?: string, after = false, groupId = '') {
    if (ref.kind !== 'regex') throw new Error('此拖动仅用于正则');
    this.guard(ref);
    const doc = await this.load(ref);
    if (beforeId === id) return;
    if (groupId && !doc.state.groups.some(g => g.id === groupId)) throw new Error('目标分组已不存在');
    if (!doc.entries.some(e => e.id === id) || (beforeId && !doc.entries.some(e => e.id === beforeId))) throw new Error('条目已变化，请重试');
    if (groupId && !beforeId) {
      const group = doc.state.groups.find(g => g.id === groupId)!;
      beforeId = doc.entries.filter(e => e.id !== id && group.members.includes(e.id)).at(-1)?.id;
      after = !!beforeId;
    }
    const moved = transferEntries(doc, doc, [id], 'move', beforeId, after, groupId || undefined);
    assignGroup(doc, moved, groupId || undefined);
    // Preserve other schemes; serialize writes only the schemes explicitly chosen for synchronization.
    this.guard(ref);
    await saveDocuments(this.host, [doc]);
    this.changed([ref]);
  }
  async nativePresetGroup(ref: Resource, id: string, groupId: string, order: string[]) {
    if (ref.kind !== 'preset') throw new Error('此操作仅用于原生预设');
    this.guard(ref);
    const doc = await this.load(ref);
    if (order.length !== doc.entries.length || order.some((id, i) => id !== doc.entries[i].id))
      throw new Error('预设顺序已变化，已停止写入分组，请重新载入');
    if (!doc.entries.some(e => e.id === id)) throw new Error('条目已不存在');
    if (groupId && !doc.state.groups.some(g => g.id === groupId)) throw new Error('目标分组已不存在');
    if ((doc.state.groups.find(g => g.members.includes(id))?.id || '') === groupId) return;
    // Native Sortable already saved the order. Only change membership, preserving every native flag.
    assignGroup(doc, [id], groupId || undefined);
    this.guard(ref); await saveDocuments(this.host, [doc], [], { preserveRaw: true }); this.changed([ref]);
  }
  async erase(ref: Resource, ids: string[], detach = false) {
    const doc = await this.load(ref);
    if (ids.some(id => ![...doc.entries, ...doc.unused].some(e => e.id === id))) throw new Error('条目已不存在');
    removeEntries(doc, ids, detach);
    this.mirror(doc);
    this.guard(ref);
    await saveDocuments(this.host, [doc]);
    this.changed([ref]);
  }
  async groupEnabled(ref: Resource, id: string, enabled: boolean) {
    this.guard(ref);
    if (this.host.setGroupEnabled && await this.host.setGroupEnabled(ref, id, enabled)) {
      if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function')
        document.dispatchEvent(new CustomEvent('prw:group-state', { detail: { ref, id, enabled } }));
      return;
    }
    const doc = await this.load(ref), group = doc.state.groups.find(g => g.id === id);
    if (!group) throw new Error('分组已不存在');
    group.enabled = enabled; doc.state.native = true; doc.dirty = true;
    this.guard(ref); await saveDocuments(this.host, [doc]); this.changed([ref]);
  }
  async entryEnabled(ref: Resource, id: string, enabled: boolean) {
    const doc = await this.load(ref), entry = doc.entries.find(e => e.id === id);
    if (!entry) throw new Error('条目已不存在');
    entry.enabled = enabled; doc.dirty = true;
    this.guard(ref); await saveDocuments(this.host, [doc]); this.changed([ref]);
  }
}
