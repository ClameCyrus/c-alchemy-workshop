import { z } from 'zod';
import type {
  Entry,
  Group,
  GroupSource,
  GroupState,
  Match,
  Provider,
  Raw,
  Resource,
  Snapshot,
  WorkDocument,
} from './types';

export const NS = 'presetRegexWorkbench';
export const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
export const uid = () =>
  globalThis.crypto?.randomUUID?.() || `prw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export function stable(value: any): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map(k => [k, v[k]]),
        )
      : v,
  );
}
const GroupSchema = z.object({
  id: z.string(),
  name: z.string().default('未命名分组'),
  members: z.array(z.string()).default([]),
  collapsed: z.boolean().default(false),
  enabled: z.boolean().default(true),
  extra: z.record(z.string(), z.any()).optional(),
});
const StateSchema = z.object({
  version: z.literal(1).default(1),
  native: z.boolean().optional(),
  groups: z.array(GroupSchema).default([]),
  sync: z.array(z.enum(['baibai', 'transfer'])).default([]),
  suppressed: z.array(z.enum(['baibai', 'transfer'])).default([]),
  backups: z.array(z.record(z.string(), z.any())).optional(),
});
export function orderOf(raw: Raw): Raw[] {
  return raw.prompt_order?.find((o: Raw) => o.character_id === 100001)?.order || [];
}
export function entryFrom(raw: Raw, kind: Resource['kind'], enabled?: boolean): Entry {
  return kind === 'regex'
    ? {
        id: String(raw.id),
        name: String(raw.scriptName || '未命名正则'),
        content: `${raw.findRegex || ''}\n→\n${raw.replaceString || ''}`,
        enabled: !raw.disabled,
        role: 'regex',
        raw: clone(raw),
      }
    : {
        id: String(raw.identifier),
        name: String(raw.name || '未命名条目'),
        content: String(raw.content || ''),
        enabled: enabled ?? raw.enabled !== false,
        role: raw.role || 'system',
        raw: clone(raw),
      };
}
export function normalizeGroups(groups: Group[], ids: string[], allowOverlap = false): Group[] {
  const valid = new Set(ids),
    assigned = new Set<string>(),
    groupIds = new Set<string>();
  return groups
    .filter(g => g && g.id && !groupIds.has(g.id) && !!groupIds.add(g.id))
    .map(g => ({
      ...g,
      members: [...new Set(g.members)].filter(
        id => valid.has(id) && (allowOverlap || !assigned.has(id)) && !!assigned.add(id),
      ),
    }));
}
export function sourceGroups(
  provider: Provider,
  data: any,
  ids: string[],
  kind: Resource['kind'],
  scope: Resource['scope'],
): Group[] {
  if (!data) return [];
  if (provider === 'baibai') {
    const membership = kind === 'regex' ? data.scripts || {} : data.prompts || {};
    return normalizeGroups(
      (data.groups || []).map((g: Raw) => ({
        id: String(g.id),
        name: String(g.name || '未命名分组'),
        members: ids.filter(id => membership[id]?.groupId === g.id),
        collapsed: !!g.collapsed,
        enabled: g.enabled !== false,
        extra: clone(g),
      })),
      ids,
      true,
    );
  }
  const list = Array.isArray(data) ? data : data.groups || [];
  return normalizeGroups(
    list
      .filter((g: Raw) => kind !== 'regex' || (g.scope || 'global') === scope)
      .map((g: Raw) => {
        let members = g.memberIdentifiers || g.memberIds || g.members;
        if (!Array.isArray(members)) {
          const a = Number.isInteger(g.startIndex) ? g.startIndex : ids.indexOf(g.startIdentifier);
          const b = Number.isInteger(g.endIndex) ? g.endIndex : ids.indexOf(g.endIdentifier);
          const offset = g.mode === 'exclusive' ? 1 : 0;
          members = a >= 0 && b >= 0 ? ids.slice(Math.min(a, b) + offset, Math.max(a, b) + 1 - offset) : [];
        }
        return {
          id: String(g.id || uid()),
          name: String(g.name || '未命名分组'),
          members: members.map(String),
          collapsed: g.collapsed ?? true,
          enabled: true,
          extra: clone(g),
        };
      })
      .filter((g: Group) => g.members.some(id => ids.includes(id))),
    ids,
    true,
  );
}
export function makeDocument(ref: Resource, snapshot: Snapshot): WorkDocument {
  const raw = snapshot.raw;
  let entries: Entry[],
    unused: Entry[] = [];
  if (ref.kind === 'regex') entries = (raw || []).map((r: Raw) => entryFrom(r, 'regex'));
  else {
    const order = orderOf(raw),
      map = new Map<string, Raw>((raw.prompts || []).map((r: Raw) => [String(r.identifier), r]));
    entries = order
      .filter(o => map.has(String(o.identifier)))
      .map(o => entryFrom(map.get(String(o.identifier))!, 'preset', o.enabled !== false));
    const used = new Set(entries.map(e => e.id));
    unused = (raw.prompts || [])
      .filter((r: Raw) => !used.has(String(r.identifier)))
      .map((r: Raw) => ({ ...entryFrom(r, 'preset'), unused: true }));
  }
  const ids = [...entries, ...unused].map(e => e.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !id || id === 'undefined'))
    throw new Error('资源存在重复或缺失ID，已停止载入以避免错误映射');
  const parsed = StateSchema.safeParse(snapshot.own);
  if (snapshot.own && !parsed.success) throw new Error(`本插件分组格式无效：${z.prettifyError(parsed.error)}`);
  const state: GroupState = parsed.success ? parsed.data : { version: 1, groups: [], sync: [], suppressed: [] };
  state.groups = normalizeGroups(state.groups, ids);
  const sources: GroupSource[] = [];
  if (snapshot.own) sources.push({ provider: 'own', label: '工坊', groups: clone(state.groups), raw: snapshot.own });
  for (const provider of ['baibai', 'transfer'] as const) {
    const groups = sourceGroups(provider, snapshot[provider], ids, ref.kind, ref.scope);
    const records = snapshot[provider];
    const orphanGlobal = provider === 'transfer' && ref.kind === 'regex' && ref.scope === 'global' &&
      (Array.isArray(records) ? records : records?.groups || []).some((g: Raw) => (g.scope || 'global') === 'global');
    if (groups.length || orphanGlobal || (provider === 'baibai' && records !== undefined))
      sources.push({
        provider,
        label: provider === 'baibai' ? '柏宝箱' : '预设转移工具',
        groups,
        raw: snapshot[provider],
      });
  }
  return {
    ref: clone(ref),
    baseline: stable(snapshot),
    snapshot: clone(snapshot),
    entries,
    unused,
    state,
    sources,
    cleanup: [],
    dirty: false,
  };
}
export function rawEntry(entry: Entry, kind: Resource['kind']): Raw {
  return kind === 'regex'
    ? { ...clone(entry.raw), id: entry.id, scriptName: entry.name, ...(entry.enabled === !entry.raw.disabled ? {} : { disabled: !entry.enabled }) }
    : {
        ...clone(entry.raw),
        identifier: entry.id,
        name: entry.name,
        content: entry.content,
        role: entry.role,
      };
}
function portableGroups(doc: WorkDocument): any {
  if (doc.ref.kind === 'regex') {
    const scripts: Raw = {};
    doc.entries.forEach((e, order) => { scripts[e.id] = { ...clone(doc.snapshot.baibai?.scripts?.[e.id]), groupId: '__ungrouped', order }; });
    for (const g of doc.state.groups)
      g.members.forEach((id, order) => {
        scripts[id] = { ...scripts[id], groupId: g.id, order };
      });
    return {
      ...clone(doc.snapshot.baibai),
      version: 1,
      groups: doc.state.groups.map((g, order) => ({
        ...g.extra,
        id: g.id,
        name: g.name,
        order,
        collapsed: g.collapsed,
      })),
      scripts,
      ungrouped: doc.snapshot.baibai?.ungrouped || { name: '未分组', collapsed: false },
    };
  }
  const prompts: Raw = {};
  for (const g of doc.state.groups) for (const id of g.members) prompts[id] = { ...clone(doc.snapshot.baibai?.prompts?.[id]), groupId: g.id };
  return {
    ...clone(doc.snapshot.baibai),
    version: 1,
    groups: doc.state.groups.map((g, order) => ({
      ...g.extra,
      id: g.id,
      name: g.name,
      order,
      collapsed: g.collapsed,
      enabled: g.enabled,
    })),
    prompts,
  };
}
export function transformTransfer(doc: WorkDocument, current: any, clear = false): any {
  if (doc.ref.kind === 'preset')
    return clear
      ? undefined
      : doc.state.groups.map(g => ({
          ...g.extra,
          id: g.id,
          name: g.name,
          mode: 'inclusive',
          memberIdentifiers: [...g.members],
        }));
  const relevant = new Set(
    [...doc.entries, ...doc.unused, ...doc.snapshot.raw.map((r: Raw) => ({ id: r.id }))].map(
      (e: { id: string }) => e.id,
    ),
  );
  const source = Array.isArray(current) ? current : current?.groups || [];
  const untouched = source
    .filter((g: Raw) => !(clear && doc.ref.scope === 'global' && (g.scope || 'global') === 'global'))
    .map((g: Raw) => {
      if ((g.scope || 'global') !== doc.ref.scope) return clone(g);
      return { ...clone(g), memberIds: (g.memberIds || g.members || []).filter((id: string) => !relevant.has(id)) };
    })
    .filter((g: Raw) => (g.memberIds || g.members || []).length);
  return {
    ...(Array.isArray(current) ? {} : current),
    version: 2,
    groups: [
      ...untouched,
      ...(clear
        ? []
        : doc.state.groups
            .filter(g => g.members.length)
            .map(g => ({
              ...g.extra,
              id: g.id,
              name: g.name,
              scope: doc.ref.scope,
              memberIds: [...g.members],
              collapsed: g.collapsed,
            }))),
    ],
  };
}
export function serialize(doc: WorkDocument): Snapshot {
  const out = clone(doc.snapshot),
    ids = [...doc.entries, ...doc.unused].map(e => e.id);
  out.own = clone(doc.state);
  out.own.groups = normalizeGroups(out.own.groups, ids);
  const deleted = new Set(doc.cleanup);
  if (doc.cleanup.length)
    out.own.backups = [
      ...(out.own.backups || []),
      ...doc.cleanup.map(provider => ({
        provider,
        date: new Date().toISOString(),
        data: clone(doc.snapshot[provider] ?? null),
      })),
    ].slice(-10);
  for (const provider of ['baibai', 'transfer'] as const) {
    const independent = doc.providerGroups?.[provider];
    if (independent && !deleted.has(provider)) {
      const alternate = { ...doc, state: { ...doc.state, groups: independent } };
      out[provider] = provider === 'baibai' ? portableGroups(alternate) : transformTransfer(alternate, out.transfer);
      continue;
    }
    if (deleted.has(provider))
      out[provider] =
        provider === 'transfer' && doc.ref.kind === 'regex' ? transformTransfer(doc, out.transfer, true) : undefined;
    else if (doc.state.sync.includes(provider) && !doc.state.suppressed.includes(provider))
      out[provider] = provider === 'baibai' ? portableGroups(doc) : transformTransfer(doc, out.transfer);
  }
  if (doc.ref.kind === 'regex') out.raw = doc.entries.map(e => rawEntry(e, 'regex'));
  else {
    out.raw.prompts = [...doc.entries, ...doc.unused].map(e => rawEntry(e, 'preset'));
    const oldOrder = new Map<string, Raw>(orderOf(out.raw).map(o => [String(o.identifier), o]));
    let container = out.raw.prompt_order?.find((o: Raw) => o.character_id === 100001);
    if (!container) {
      out.raw.prompt_order ||= [];
      container = { character_id: 100001, order: [] };
      out.raw.prompt_order.push(container);
    }
    container.order = doc.entries.map(e => ({ ...oldOrder.get(e.id), identifier: e.id, enabled: e.enabled }));
    const valid = new Set(ids);
    for (const order of out.raw.prompt_order)
      order.order = order.order.filter((e: Raw) => valid.has(String(e.identifier)));
  }
  return out;
}
export function protectedEntry(entry: Entry): boolean {
  return !!(entry.raw.system_prompt || entry.raw.marker);
}
export function pausedMembers(state?: { groups?: Group[] }): Set<string> {
  return new Set((state?.groups || []).filter(g => g.enabled === false).flatMap(g => g.members));
}
export function groupOf(doc: WorkDocument, id: string): Group | undefined {
  return doc.state.groups.find(g => g.members.includes(id));
}
export function assignGroup(doc: WorkDocument, ids: string[], groupId?: string) {
  const set = new Set(ids),
    group = doc.state.groups.find(g => g.id === groupId);
  doc.state.groups.forEach(g => {
    g.members = g.members.filter(id => !set.has(id));
  });
  group?.members.push(...ids);
  doc.dirty = true;
}
export function removeEntries(doc: WorkDocument, ids: string[], detach = false) {
  const set = new Set(ids),
    entries = [...doc.entries, ...doc.unused].filter(e => set.has(e.id));
  if (entries.some(protectedEntry)) throw new Error('系统或占位条目不能移除或删除');
  doc.entries = doc.entries.filter(e => !set.has(e.id));
  doc.unused = doc.unused.filter(e => !set.has(e.id));
  if (detach) doc.unused.push(...entries.map(e => ({ ...e, unused: true })));
  else
    doc.state.groups.forEach(g => {
      g.members = g.members.filter(id => !set.has(id));
    });
  doc.dirty = true;
}
export function transferEntries(
  source: WorkDocument,
  target: WorkDocument,
  ids: string[],
  action: 'copy' | 'move',
  beforeId?: string,
  after = false,
  targetGroupId?: string,
): string[] {
  if (source.ref.kind !== target.ref.kind) throw new Error('预设条目和正则不能混合转移');
  const set = new Set(ids),
    entries = [...source.entries, ...source.unused].filter(e => set.has(e.id));
  if (!entries.length || entries.length !== set.size) throw new Error('部分来源条目已不存在，请重新选择');
  if (entries.some(protectedEntry)) throw new Error('系统或占位条目不能复制或移动');
  if (targetGroupId && !target.state.groups.some(g => g.id === targetGroupId)) throw new Error('目标分组已不存在');
  if (beforeId && !target.entries.some(e => e.id === beforeId)) throw new Error('目标位置已不存在');
  if (source === target && action === 'move' && beforeId && set.has(beforeId)) return [];
  const same = source.ref.key === target.ref.key;
  const names = new Set([...target.entries, ...target.unused].map(e => e.name)),
    idsInTarget = new Set([...target.entries, ...target.unused].map(e => e.id));
  const next = entries.map(e => {
    const copy = clone(e);
    delete copy.unused;
    if (action === 'copy') {
      copy.id = uid();
      const base = `${e.name}（副本）`;
      let name = base;
      let n = 2;
      while (names.has(name)) name = `${base} ${n++}`;
      copy.name = name;
      names.add(name);
      if (source.ref.kind === 'regex') copy.enabled = false;
    } else if (!same && idsInTarget.has(copy.id)) copy.id = uid();
    idsInTarget.add(copy.id);
    return copy;
  });
  const originalGroups = entries.map(e => groupOf(source, e.id)?.id);
  if (action === 'move') {
    source.entries = source.entries.filter(e => !set.has(e.id));
    source.unused = source.unused.filter(e => !set.has(e.id));
    if (!same)
      source.state.groups.forEach(g => {
        g.members = g.members.filter(id => !set.has(id));
      });
    source.dirty = true;
  }
  const index = beforeId ? target.entries.findIndex(e => e.id === beforeId) + (after ? 1 : 0) : target.entries.length;
  target.entries.splice(index, 0, ...next);
  next.forEach((e, i) => {
    const destination = targetGroupId || (same ? originalGroups[i] : undefined);
    if (destination) assignGroup(target, [e.id], destination);
  });
  target.dirty = true;
  return next.map(e => e.id);
}
const normalized = (s: string) => s.replace(/\r\n/g, '\n').trim();
function bigrams(text: string): Set<string> {
  const s = text.replace(/\s+/g, ' ').toLowerCase();
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
const gramsCache = new Map<string, Set<string>>();
let gramsCost = 0;
function cachedGrams(s: string) {
  let g = gramsCache.get(s);
  if (!g) {
    g = bigrams(s);
    const cost = s.length + g.size * 16;
    if (cost > 8_000_000) return g;
    while (gramsCache.size && (gramsCache.size >= 1200 || gramsCost + cost > 8_000_000)) {
      const [key, value] = gramsCache.entries().next().value!;
      gramsCache.delete(key);
      gramsCost -= key.length + value.size * 16;
    }
    gramsCost += cost;
    gramsCache.set(s, g);
  } else { gramsCache.delete(s); gramsCache.set(s, g); }
  return g;
}
export function settingsOf(e: Entry): Raw {
  const r = e.raw;
  return {
    enabled: e.enabled,
    role: e.role,
    position: r.injection_position,
    depth: r.injection_depth,
    order: r.injection_order,
    triggers: [...(r.injection_trigger || [])].sort(),
    overrides: r.forbid_overrides,
    placement: r.placement,
    trim: r.trimStrings,
    substitute: r.substituteRegex,
    min: r.minDepth,
    max: r.maxDepth,
    markdown: r.markdownOnly,
    prompt: r.promptOnly,
    edit: r.runOnEdit,
  };
}
export function matchEntries(a: Entry, b: Entry, threshold = 0.5): Match | null {
  const x = normalized(a.content),
    y = normalized(b.content),
    settingsDifferent = stable(settingsOf(a)) !== stable(settingsOf(b));
  if (x === y && (x.length > 0 || a.id === b.id || a.name === b.name))
    return { type: 'exact', score: 1, coverage: 1, settingsDifferent };
  if (!x || !y)
    return a.id === b.id || a.name === b.name ? { type: 'similar', score: 0.01, coverage: 0, settingsDifferent } : null;
  const gx = cachedGrams(x),
    gy = cachedGrams(y);
  let common = 0;
  gx.forEach(g => {
    if (gy.has(g)) common++;
  });
  const score = (2 * common) / Math.max(1, gx.size + gy.size),
    coverage = common / Math.max(1, Math.min(gx.size, gy.size));
  const small = x.length < y.length ? x : y,
    big = x.length < y.length ? y : x;
  const sharedBlock =
    (small.length >= 24 && big.includes(small)) ||
    small.split('\n').some(p => p.trim().length >= 40 && big.includes(p.trim()));
  if (sharedBlock && coverage >= 0.45) return { type: 'partial', score, coverage, settingsDifferent };
  if ((Math.min(x.length, y.length) >= 16 && score >= threshold) || a.id === b.id || a.name === b.name)
    return { type: 'similar', score, coverage, settingsDifferent };
  return null;
}
export function rangeMembers(doc: WorkDocument, a: string, b: string): string[] {
  const i = doc.entries.findIndex(e => e.id === a),
    j = doc.entries.findIndex(e => e.id === b);
  if (i < 0 || j < 0) throw new Error('范围起点或终点已不存在，请重新选择');
  return doc.entries.slice(Math.min(i, j), Math.max(i, j) + 1).map(e => e.id);
}
