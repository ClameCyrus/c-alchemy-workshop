import { assignGroup, clone, entryFrom, protectedEntry, stable, uid } from './core';
import { promptEntry, type LibraryItem } from './library';
import { renameVariables, scanVariables, variableKey, variableMacro, type VariableScope } from './variables';
import type { Entry, WorkDocument } from './types';

export interface LibraryPart {
  key: string; itemId: string; original: Entry; selected: boolean;
  mode: 'keep' | 'wrap' | 'reminder'; name: string; scope: VariableScope; reminder: string;
  position?: { id: string; after: boolean; groupId: string };
  insertedId?: string;
  prefix?: string;
  suffix?: string;
}
export interface VariableBinding {
  key: string; scope: VariableScope; from: string; to: string;
  share: boolean; initialize: boolean; initial: string; reference: boolean;
}
export interface InsertionOptions {
  beforeId: string; after: boolean; groupId: string; keepGroups: boolean; enabled: boolean;
  initId: string; initEnabled: boolean; referenceId: string; referenceText: string;
  bindings: VariableBinding[];
  requirePositions?: boolean;
}
export function libraryParts(items: LibraryItem[]): LibraryPart[] {
  return items.flatMap(item => item.entries.map(e => ({ key: `${item.id}/${e.id}`, itemId: item.id, original: clone(e),
    selected: true, mode: 'keep' as const, name: e.name, scope: 'local' as const, reminder: '', insertedId: uid(), prefix: '', suffix: '' })));
}
export function partContent(part: LibraryPart) {
  return `${part.prefix || ''}${variableContent(part)}${part.suffix || ''}`;
}
function variableContent(part: LibraryPart) {
  if (part.mode === 'keep') return part.original.content;
  if (scanVariables(part.original.content).macros.length) throw new Error(`「${part.original.name}」已有变量，请保留原样或先编辑条目`);
  if (part.mode === 'wrap') {
    const text = variableMacro(part.scope, part.name, part.original.content);
    if (scanVariables(text).macros.find(m => m.start === 0)?.end !== text.length || scanVariables(text).issues.length)
      throw new Error(`「${part.original.name}」包含复杂或不完整宏，请保留原样`);
    return text;
  }
  if (!part.reminder.trim()) throw new Error(`填写「${part.original.name}」的引用短句`);
  return `${variableMacro(part.scope, part.name, part.reminder)}\n${part.original.content}`;
}
export function insertionVariables(parts: LibraryPart[]) {
  const found = new Map<string, { scope: VariableScope; name: string; writes: number; reads: number }>();
  for (const part of parts.filter(p => p.selected)) {
    for (const m of scanVariables(partContent(part)).macros) {
      if (m.dynamic) continue;
      const key = variableKey(m.scope, m.name), value = found.get(key) || { scope: m.scope, name: m.name, writes: 0, reads: 0 };
      if (/^(set|add|inc|dec|delete)/.test(m.action)) value.writes++; else value.reads++;
      found.set(key, value);
    }
  }
  return [...found].map(([key, v]) => ({ key, ...v }));
}
export function insertLibraryItems(original: WorkDocument, items: LibraryItem[], parts: LibraryPart[], options: InsertionOptions) {
  const doc = clone(original), chosen = parts.filter(p => p.selected), warnings: string[] = [];
  if (!chosen.length) throw new Error('先选择条目条目');
  if (items.some(i => i.kind !== doc.ref.kind)) throw new Error('条目类型与目标不一致');
  if (doc.snapshot.legacyOwn && !doc.legacyResolved) throw new Error('新旧分组不同，请先选择分组方案');
  if (options.beforeId && !doc.entries.some(e => e.id === options.beforeId)) throw new Error('目标位置已不存在');
  if (options.groupId && !doc.state.groups.some(g => g.id === options.groupId)) throw new Error('目标分组已不存在');
  const existingIds = new Set([...original.entries, ...original.unused].map(e => e.id));
  const inserted = new Map<string, LibraryPart>();
  for (const part of chosen) if (part.insertedId) {
    if (existingIds.has(part.insertedId) || inserted.has(part.insertedId)) throw new Error('新增条目标识重复，请重新打开条目库');
    inserted.set(part.insertedId, part);
  }
  for (const part of chosen) {
    if (options.requirePositions && !part.position) throw new Error(`为「${part.original.name}」选择插入位置`);
    const position = part.position;
    if (position?.id && !original.entries.some(e => e.id === position.id) && !inserted.has(position.id)) throw new Error('目标位置已不存在');
    if (position?.groupId && !doc.state.groups.some(g => g.id === position.groupId)) throw new Error('目标分组已不存在');
  }
  const names = Object.fromEntries(options.bindings.map(b => [b.key, b.to]));
  const variables = doc.ref.kind === 'preset' ? insertionVariables(chosen) : [];
  const targetMacros = doc.entries.flatMap(e => scanVariables(e.content).macros);
  for (const v of variables) {
    const b = options.bindings.find(b => b.key === v.key);
    if (!b) throw new Error('变量列表已变化，请重新检查');
    variableMacro(b.scope, b.to);
    const conflict = targetMacros.some(m => m.scope === b.scope && m.name === b.to) ||
      options.bindings.some(other => other.key !== b.key && other.scope === b.scope && other.to === b.to);
    if (conflict && !b.share) throw new Error(`变量「${b.to}」已存在，请改名或确认共用`);
    if (!v.writes && !b.initialize && !targetMacros.some(m => m.scope === b.scope && m.name === b.to && /^(set|add)/.test(m.action)))
      warnings.push(`「${b.to}」只有读取，需由其他条目提供值`);
  }
  const idMap = new Map<string, string>();
  const added = chosen.map(p => {
    const entry = clone(p.original);
    if (protectedEntry(entry)) throw new Error('系统或占位条目不能作为条目插入');
    entry.id = p.insertedId || uid(); delete entry.unused; entry.enabled = options.enabled;
    if (doc.ref.kind === 'preset') {
      entry.content = renameVariables(partContent(p), names);
      warnings.push(...scanVariables(entry.content).issues);
    } else entry.content = entryFrom(entry.raw, 'regex').content;
    idMap.set(p.key, entry.id);
    return entry;
  });
  const cursors = new Map<string, string>();
  const ordered: LibraryPart[] = [], visiting = new Set<LibraryPart>(), visited = new Set<LibraryPart>();
  function visit(part: LibraryPart) {
    if (visited.has(part)) return;
    if (visiting.has(part)) throw new Error('插入位置相互依赖，请重新选择');
    visiting.add(part);
    const parent = part.position?.id && inserted.get(part.position.id);
    if (parent) visit(parent);
    visiting.delete(part); visited.add(part); ordered.push(part);
  }
  chosen.forEach(visit);
  ordered.forEach(part => {
    const i = chosen.indexOf(part);
    const position = part.position || { id: options.beforeId, after: options.after, groupId: options.groupId };
    const key = `${position.id}/${position.after}`, cursor = cursors.get(key);
    const index = cursor ? doc.entries.findIndex(e => e.id === cursor) + 1 : position.id ? doc.entries.findIndex(e => e.id === position.id) + (position.after ? 1 : 0) : doc.entries.length;
    doc.entries.splice(index, 0, added[i]); cursors.set(key, added[i].id);
    if (position.groupId) assignGroup(doc, [added[i].id], position.groupId);
  });
  if (options.keepGroups) for (const item of items) for (const group of item.groups) {
    const members = group.members.map(id => idMap.get(`${item.id}/${id}`)).filter((id): id is string => !!id && !doc.state.groups.some(g => g.members.includes(id)));
    if (members.length) { doc.state.native = true; doc.state.groups.push({ ...clone(group), id: uid(), members }); }
  }
  if (doc.ref.kind === 'preset') {
    if (options.bindings.some(b => b.reference) && !options.referenceId) throw new Error('选择引用位置，并在正文中插入引用');
    if (options.referenceId) {
      const entry = doc.entries.find(e => e.id === options.referenceId);
      if (!entry || entry.raw.marker) throw new Error('引用条目不可编辑');
      for (const b of options.bindings.filter(b => b.reference)) {
        if (!scanVariables(options.referenceText).macros.some(m => m.scope === b.scope && m.name === b.to && /^get/.test(m.action)))
          throw new Error(`请在正文中插入「${b.to}」的引用`);
      }
      entry.content = options.referenceText;
      if (!entry.enabled) warnings.push('引用条目已关闭');
      if (doc.state.groups.some(g => !g.enabled && g.members.includes(entry.id))) warnings.push('引用条目所在分组已停用');
    }
    const initializers = options.bindings.filter(b => b.initialize);
    if (initializers.length) {
      let entry = doc.entries.find(e => e.id === options.initId);
      if (!options.initId) throw new Error('选择初始化位置');
      if (options.initId === '__new') {
        entry = promptEntry('变量初始化', ''); entry.enabled = options.initEnabled; doc.entries.unshift(entry);
      }
      if (!entry || entry.raw.marker) throw new Error('初始化条目不可编辑');
      for (const b of initializers) {
        const existing = scanVariables(entry.content).macros.find(m => m.scope === b.scope && m.name === b.to && /^set/.test(m.action));
        if (existing) { warnings.push(`「${b.to}」沿用已有初始化值`); continue; }
        const block = variableMacro(b.scope, b.to, b.initial);
        if (scanVariables(block).issues.length) throw new Error(`「${b.to}」的初始值包含未闭合宏`);
        entry.content += `${entry.content && !entry.content.endsWith('\n') ? '\n' : ''}${block}`;
      }
      if (!entry.enabled) warnings.push('初始化条目已关闭');
      if (doc.state.groups.some(g => !g.enabled && g.members.includes(entry!.id))) warnings.push('初始化条目所在分组已停用');
      const initIndex = doc.entries.indexOf(entry);
      if (added.some(e => scanVariables(e.content).macros.some(m => /^(set|add)/.test(m.action))) && initIndex > Math.min(...added.map(e => doc.entries.indexOf(e))))
        warnings.push('初始化在新增条目之后，请核对处理顺序');
    }
    if (variables.length) warnings.push('宏未执行；深度、世界书和外部脚本可能影响实际处理顺序');
  }
  doc.dirty = true;
  return { doc, added: added.map(e => e.id), warnings: [...new Set(warnings)], baseline: stable(original) };
}
