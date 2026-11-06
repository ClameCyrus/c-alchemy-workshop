import { makeDocument, rawEntry, stable } from './core';
import { settingDifferences } from './entry-settings';
import type { WorkDocument } from './types';
export interface ChangeSummary { name: string; scope: string; lines: string[] }
const provider = (key: string) => key === 'baibai' ? '柏宝箱' : '预设转移工具';
export function summarizeChanges(doc: WorkDocument): ChangeSummary {
  const before = makeDocument(doc.ref, doc.ref.live && doc.snapshot.file ? doc.snapshot.file : doc.snapshot), lines: string[] = [];
  if (doc.snapshot.namespace?.legacy !== undefined) lines.push('迁移工坊分组记录并保留备份');
  const old = new Map([...before.entries, ...before.unused].map(e => [e.id, e]));
  const next = new Map([...doc.entries, ...doc.unused].map(e => [e.id, e]));
  for (const [id, entry] of next) {
    const original = old.get(id);
    if (!original) { lines.push(`新增「${entry.name}」${entry.unused ? '（未加入列表）' : ''}`); continue; }
    const changed: string[] = [];
    if (original.name !== entry.name) changed.push(`名称：${original.name} → ${entry.name}`);
    if (original.content !== entry.content) changed.push('正文');
    changed.push(...settingDifferences(original, entry).map(d => `${d.label}：${d.left} → ${d.right}`));
    if (!!original.unused !== !!entry.unused) changed.push(entry.unused ? '移出列表' : '加入列表');
    if (!changed.length && stable(rawEntry(original, doc.ref.kind)) !== stable(rawEntry(entry, doc.ref.kind))) changed.push('其他设置');
    if (changed.length) lines.push(`修改「${entry.name}」：${changed.join('；')}`);
  }
  for (const [id, entry] of old) if (!next.has(id)) lines.push(`删除「${entry.name}」`);
  const usedBefore = new Set(before.entries.map(e => e.id)), usedNow = new Set(doc.entries.map(e => e.id));
  if (stable(before.entries.filter(e => usedNow.has(e.id)).map(e => e.id)) !== stable(doc.entries.filter(e => usedBefore.has(e.id)).map(e => e.id))) lines.push('调整条目顺序');
  const oldGroups = new Map(before.state.groups.map(g => [g.id, g]));
  for (const group of doc.state.groups) {
    const original = oldGroups.get(group.id);
    if (!original) { lines.push(`新增分组「${group.name}」：${group.members.length} 条（${group.members.map(id => next.get(id)?.name || id).join('、')}）`); continue; }
    const changed: string[] = [];
    if (group.name !== original.name) changed.push(`名称：${original.name} → ${group.name}`);
    if (group.enabled !== original.enabled) changed.push(group.enabled ? '启用' : '停用');
    if (group.collapsed !== original.collapsed) changed.push(group.collapsed ? '折叠' : '展开');
    if (stable([...group.members].sort()) !== stable([...original.members].sort())) {
      const added = group.members.filter(id => !original.members.includes(id)), removed = original.members.filter(id => !group.members.includes(id));
      changed.push(`成员：${original.members.length} → ${group.members.length} 条`);
      if (added.length) changed.push(`加入：${added.map(id => next.get(id)?.name || id).join('、')}`);
      if (removed.length) changed.push(`移出：${removed.map(id => old.get(id)?.name || id).join('、')}`);
    }
    if (changed.length) lines.push(`修改分组「${group.name}」：${changed.join('；')}`);
  }
  for (const group of before.state.groups) if (!doc.state.groups.some(g => g.id === group.id)) lines.push(`解散分组「${group.name}」`);
  if (doc.cleanup.length) lines.push(`清理分组记录：${doc.cleanup.map(provider).join('、')}（保留备份）`);
  if (stable(doc.state.sync) !== stable(before.state.sync)) lines.push(`分组写回：${doc.state.sync.map(provider).join('、') || '关闭'}`);
  if (doc.state.native && !before.state.native) lines.push('采用工坊分组');
  return { name: doc.ref.label, scope: doc.ref.kind === 'preset' ? '预设' : '正则', lines: lines.length ? lines : ['保存资源与分组设置'] };
}
export function reviewSignature(docs: WorkDocument[]) {
  return stable(docs.map(d => ({ key: d.ref.key, baseline: d.baseline, entries: d.entries, unused: d.unused, state: d.state, cleanup: d.cleanup, providerGroups: d.providerGroups })));
}
