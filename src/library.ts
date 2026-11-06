import { z } from 'zod';
import { clone, entryFrom, protectedEntry, uid } from './core';
import type { Entry, Group, Kind, Raw, WorkDocument } from './types';

export interface Material extends Raw {
  id: string;
  name: string;
  folder: string;
  kind: Kind;
  entries: Entry[];
  groups: Group[];
  source: { type: 'preset' | 'regex' | 'worldbook' | 'custom'; name: string; raw?: Raw; entryIds?: Record<string, string> };
  updated: number;
}
export interface MaterialLibrary extends Raw { version: 1; items: Material[]; folders: string[] }
const entrySchema = z.object({
  id: z.string(), name: z.string(), content: z.string(), enabled: z.boolean(), role: z.string(),
  raw: z.record(z.string(), z.any()), unused: z.boolean().optional(),
}).passthrough();
const groupSchema = z.object({
  id: z.string(), name: z.string(), members: z.array(z.string()), collapsed: z.boolean(), enabled: z.boolean(),
}).passthrough();
const librarySchema = z.object({
  version: z.literal(1),
  folders: z.array(z.string()).default([]),
  items: z.array(z.object({
    id: z.string(), name: z.string().min(1), folder: z.string(), kind: z.enum(['preset', 'regex']),
    entries: z.array(entrySchema).min(1), groups: z.array(groupSchema),
    source: z.object({ type: z.enum(['preset', 'regex', 'worldbook', 'custom']), name: z.string(), raw: z.record(z.string(), z.any()).optional() }).passthrough(),
    updated: z.number(),
  }).passthrough()),
}).passthrough();
export function readLibrary(value: unknown): MaterialLibrary {
  if (value === undefined) return { version: 1, items: [], folders: [] };
  const result = librarySchema.safeParse(value);
  if (!result.success) throw new Error('素材库格式不支持，原数据未改动');
  const data = result.data as MaterialLibrary;
  const ids = new Set<string>();
  for (const item of data.items) {
    if (ids.has(item.id)) throw new Error('素材库有重复标识');
    ids.add(item.id);
    const entryIds = new Set(item.entries.map(e => e.id));
    if (entryIds.size !== item.entries.length) throw new Error('素材内有重复条目标识');
    if (item.kind === 'preset' && item.entries.some(protectedEntry)) throw new Error('素材包含系统或占位条目');
  }
  const out = clone(data), used = new Set(out.items.map(i => i.id));
  const bundles = out.items.filter(i => i.entries.length > 1);
  if (bundles.length) {
    out.legacyCollections = [...(Array.isArray(out.legacyCollections) ? out.legacyCollections : []), ...clone(bundles)];
    out.items = out.items.flatMap(item => {
      if (item.entries.length === 1) return [item];
      return splitMaterial(item, item.folder || item.name).map((row, index) => {
        let id = index ? `${item.id}~${index}` : item.id;
        while (index && used.has(id)) id += '~';
        used.add(id); row.id = id; return row;
      });
    });
  }
  out.folders = [...new Set([...out.folders, ...out.items.map(i => i.folder)].filter(Boolean))];
  return out;
}
export function splitMaterial(item: Material, folder = item.folder): Material[] {
  return item.entries.map((entry, index) => {
    const source = { ...item.source };
    if (source.type === 'worldbook' && source.raw?.entries) {
      const sourceId = item.source.entryIds?.[entry.id] ?? Object.keys(item.source.raw!.entries || {})[index];
      if (sourceId !== undefined) {
        source.raw = { ...source.raw, entries: { [sourceId]: item.source.raw!.entries[sourceId] } };
        source.entryIds = { [entry.id]: sourceId };
      }
    }
    return clone({ ...item, id: index ? `${item.id}~${index}` : item.id, name: entry.name, folder, entries: [entry], source,
      groups: item.groups.filter(g => g.members.includes(entry.id)).map(g => ({ ...g, members: [entry.id] })) });
  });
}
export function moveMaterials(library: MaterialLibrary, ids: string[], folder: string) {
  const next = clone(library), name = folder.trim();
  if (name && !next.folders.includes(name)) next.folders.push(name);
  for (const item of next.items) if (ids.includes(item.id)) { item.folder = name; item.updated = Date.now(); }
  return next;
}
export function promptEntry(name: string, content: string, role = 'system'): Entry {
  return entryFrom({ identifier: uid(), name, content, role, system_prompt: false, marker: false,
    injection_position: 0, injection_depth: 4, injection_order: 100 }, 'preset', false);
}
export function collectMaterial(doc: WorkDocument, ids: string[]): Material {
  const entries = [...doc.entries, ...doc.unused].filter(e => ids.includes(e.id));
  if (!entries.length) throw new Error('先选择条目');
  if (entries.some(protectedEntry)) throw new Error('系统或占位条目不能收藏');
  return { id: uid(), name: entries.length === 1 ? entries[0].name : `${doc.ref.name || doc.ref.label} · ${entries.length} 条`,
    folder: '', kind: doc.ref.kind, entries: clone(entries),
    groups: clone(doc.state.groups.filter(g => g.members.some(id => ids.includes(id))).map(g => ({ ...g, members: g.members.filter(id => ids.includes(id)) }))),
    source: { type: doc.ref.kind, name: doc.ref.name || doc.ref.label }, updated: Date.now() };
}
export function customMaterial(): Material {
  return { id: uid(), name: '新素材', folder: '', kind: 'preset', entries: [promptEntry('新素材', '')],
    groups: [], source: { type: 'custom', name: '' }, updated: Date.now() };
}
export function worldbookMaterial(name: string, raw: Raw, ids: string[]): Material {
  const rows = Object.entries(raw.entries || {}).filter(([id]) => ids.includes(id));
  if (!rows.length) throw new Error('先选择世界书条目');
  const entries = rows.map(([id, row]: [string, any]) => {
    const e = promptEntry(String(row.comment || row.key?.join('、') || `条目 ${row.uid ?? id}`), String(row.content || ''));
    e.enabled = false;
    return e;
  });
  return { id: uid(), name: rows.length === 1 ? entries[0].name : `${name} · ${rows.length} 条`, folder: '', kind: 'preset', entries,
    groups: [], source: { type: 'worldbook', name, raw: { ...clone(raw), entries: Object.fromEntries(clone(rows)) }, entryIds: Object.fromEntries(entries.map((e, i) => [e.id, rows[i][0]])) }, updated: Date.now() };
}
