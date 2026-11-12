import { clearLegacyField, clone, globalGroups, legacyConflict, LEGACY_NS, makeDocument, NS, orderOf, ownGroups, serialize, stable, transformTransfer } from './core';
import type { Host, Kind, Raw, Resource, Snapshot, WorkDocument } from './types';
import { assertPresetReady } from './native-preset-refresh';
import { readLibrary, type EntryLibraryData } from './library';

const ctx = () => {
  const c = window.SillyTavern?.getContext?.();
  if (!c) throw new Error('酒馆还没准备好');
  return c;
};
const nativeModule = (path: string): Promise<any> =>
  import(/* webpackIgnore: true */ new URL(path, location.href).href);
function assignObject(target: Raw, value: Raw) {
  for (const key of Object.keys(target)) if (!(key in value)) delete target[key];
  Object.assign(target, clone(value));
}
function assignArray(target: any[], value: any[]) {
  target.splice(0, target.length, ...clone(value));
}
function getManager() {
  const m = ctx().getPresetManager('openai');
  if (!m) throw new Error('未找到对话补全预设');
  return m;
}
function presetRaw(ref: Resource): Raw {
  if (ref.live) assertPresetReady();
  const m = getManager();
  const value = ref.live ? m.getPresetList().settings : m.getCompletionPresetByName(ref.name);
  if (!value || !Array.isArray(value.prompts)) throw new Error('预设不存在或格式不支持');
  if (ref.live && m.getSelectedPresetName() !== ref.name) throw new Error('当前预设已切换，请重新打开');
  return value;
}
function character(ref: Resource): Raw {
  const matches = ctx().characters.filter((ch: Raw) => ch.avatar === ref.avatar);
  if (matches.length !== 1) throw new Error('角色已删除或标识冲突，请重新打开');
  return matches[0];
}
function regexKey(ref: Resource) {
  return ref.scope === 'preset'
    ? `preset:openai:${ref.name}`
    : ref.scope === 'scoped'
      ? `scoped:${ref.avatar}`
      : 'global';
}
function rawExtensions(ref: Resource): Raw {
  return ref.scope === 'preset'
    ? presetRaw(ref).extensions || {}
    : ref.scope === 'scoped'
      ? character(ref).data?.extensions || {}
      : {};
}
function groupFields(ext: Raw, snapshot: Snapshot, kind: Kind, restore = false) {
  const ownKey = kind === 'preset' ? 'promptGroups' : 'regexGroups';
  const baiKey = kind === 'preset' ? 'presetPromptGroups' : 'regexGroups';
  clearLegacyField(ext, ownKey);
  if (restore && snapshot.namespace?.legacy !== undefined) {
    ext[LEGACY_NS] ||= {}; ext[LEGACY_NS][ownKey] = clone(snapshot.namespace.legacy);
  }
  for (const [namespace, key, value] of [
    [NS, ownKey, restore && snapshot.namespace ? snapshot.namespace.current : snapshot.own],
    ['baibaiToolkit', baiKey, snapshot.baibai],
  ] as const) {
    if (value === undefined) {
      if (ext[namespace]) {
        delete ext[namespace][key];
        if (!Object.keys(ext[namespace]).length) delete ext[namespace];
      }
    } else {
      ext[namespace] ||= {};
      ext[namespace][key] = clone(value);
    }
  }
  if (kind === 'preset') {
    if (snapshot.transfer === undefined) delete ext.entryGrouping;
    else ext.entryGrouping = clone(snapshot.transfer);
  }
}
export class NativeHost implements Host {
  private libraryBusy = false;
  constructor(private moduleLoader: (path: string) => Promise<any> = nativeModule,
    private request: typeof fetch = (...args) => fetch(...args)) {}
  private async characterRequest(ref: Resource, endpoint: string, body: Raw) {
    character(ref);
    const c = ctx(), headers = c.getRequestHeaders || (await this.moduleLoader('/script.js')).getRequestHeaders;
    if (typeof headers !== 'function') throw new Error('酒馆缺少角色保存请求接口');
    const response = await this.request(`/api/characters/${endpoint}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`角色读取或保存失败（${response.status}）：${ref.label}`);
    return response;
  }
  private async characterExtensions(ref: Resource, fresh = false) {
    const c = ctx(), ch = character(ref);
    if (!fresh && c.characters[c.characterId]?.avatar === ref.avatar && !ch.shallow) return ch.data?.extensions || {};
    const response = await this.characterRequest(ref, 'get', { avatar_url: ref.avatar });
    const raw = await response.json();
    character(ref);
    if (!raw?.data || (raw.avatar && raw.avatar !== ref.avatar)) throw new Error('目标角色数据无效，请重新选择');
    return raw.data.extensions || {};
  }
  private async writeCharacter(ref: Resource, fields: Raw) {
    // One checked request by stable avatar, rather than index-based writes whose API swallows HTTP errors.
    const before = await this.characterExtensions(ref, true);
    let deletion = false;
    const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const patch = (old: any, next: any): any => {
      if (next === undefined) { deletion = true; return undefined; }
      if (!object(next)) return clone(next);
      return Object.fromEntries([...new Set([...Object.keys(object(old) ? old : {}), ...Object.keys(next)])]
        .filter(key => stable(old?.[key]) !== stable(next[key]))
        .map(key => [key, patch(old?.[key], next[key])]));
    };
    const payload = Object.fromEntries(Object.keys(fields).filter(key => stable(before[key]) !== stable(fields[key]))
      .map(key => [key, patch(before[key], fields[key])]));
    let unset: string | undefined;
    if (deletion) {
      unset = (await this.moduleLoader('/scripts/extensions.js')).UNSET_VALUE;
      if (typeof unset !== 'string') throw new Error('当前酒馆缺少角色字段清理接口，已停止写入');
    }
    const encode = (value: any): any => value === undefined ? unset : object(value)
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) : value;
    await this.characterRequest(ref, 'merge-attributes', { avatar: ref.avatar, data: { extensions: encode(payload) } });
    const written = await this.characterExtensions(ref, true);
    if (Object.keys(fields).some(key => stable(written[key]) !== stable(fields[key])))
      throw new Error(`角色保存校验失败：${ref.label}`);
    const c = ctx(), ch = character(ref);
    ch.data ||= {}; ch.data.extensions ||= {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete ch.data.extensions[key]; else ch.data.extensions[key] = clone(value);
    }
    if (ch.json_data) {
      const json = JSON.parse(ch.json_data); json.data ||= {}; json.data.extensions ||= {};
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete json.data.extensions[key]; else json.data.extensions[key] = clone(value);
      }
      ch.json_data = JSON.stringify(json);
      if (c.characters[c.characterId]?.avatar === ref.avatar && typeof document !== 'undefined') {
        const input = document.querySelector<HTMLInputElement>('#character_json_data'); if (input) input.value = ch.json_data;
      }
    }
  }
  async loadLibrary() { return readLibrary(ownGroups(ctx().extensionSettings, 'library')); }
  async saveLibrary(value: EntryLibraryData, baseline: string) {
    if (this.libraryBusy) throw new Error('条目库正在保存，请稍后重试');
    this.libraryBusy = true;
    try {
      const next = readLibrary(value), module = await this.moduleLoader('/script.js'), settings = ctx().extensionSettings;
      if (stable(readLibrary(ownGroups(settings, 'library'))) !== baseline) throw new Error('条目库已在别处修改，请导出本次编辑后重新载入');
      const before = clone(settings[NS]?.library), legacy = clone(settings[LEGACY_NS]?.library), namespace = settings[NS] ||= {};
      namespace.library = clone(next);
      clearLegacyField(settings, 'library');
      try { await module.saveSettings(); }
      catch (error) {
        if (namespace.library !== undefined && stable(namespace.library) === stable(next)) {
          if (before === undefined) delete namespace.library; else namespace.library = before;
          if (legacy !== undefined) { settings[LEGACY_NS] ||= {}; settings[LEGACY_NS].library = legacy; }
          try { await module.saveSettings(); }
          catch { throw new Error(`条目库保存和恢复均失败，请保留本次编辑并导出备份。${String(error)}`); }
        }
        throw error;
      }
    } finally { this.libraryBusy = false; }
  }
  async worldbooks(): Promise<string[]> {
    const module = await this.moduleLoader('/scripts/world-info.js');
    return [...module.world_names].sort((a: string, b: string) => a.localeCompare(b, 'zh-CN'));
  }
  async loadWorldbook(name: string): Promise<Raw> {
    const module = await this.moduleLoader('/scripts/world-info.js');
    if (!module.world_names.includes(name)) throw new Error('世界书已不存在');
    const value = await module.loadWorldInfo(name);
    if (!value?.entries || typeof value.entries !== 'object') throw new Error('世界书格式不支持');
    return clone(value);
  }
  async setGroupEnabled(ref: Resource, id: string, enabled: boolean) {
    if (ref.scope === 'preset' && ref.live) {
      const doc = makeDocument(ref, await this.load(ref)), group = doc.state.groups.find(g => g.id === id);
      if (!group) throw new Error('分组已变更，请重新打开');
      group.enabled = enabled; doc.dirty = true;
      await this.commit([{ doc, snapshot: serialize(doc) }]);
      if (typeof document !== 'undefined') document.dispatchEvent(new Event('prw:runtime-sync'));
      return true;
    }
    // Native views refer to live resources; named files still use the normal guarded save path.
    if (ref.scope === 'preset' && !ref.live) return false;
    const legacyContainer = ref.scope === 'global' ? ctx().extensionSettings : rawExtensions(ref);
    if (legacyContainer[LEGACY_NS]) return false;
    const module = await this.moduleLoader('/script.js'), c = ctx();
    if (!this.resources(ref.kind).some(r => r.key === ref.key && r.name === ref.name && r.avatar === ref.avatar))
      throw new Error('当前预设或角色已切换，请重试');
    const ext = rawExtensions(ref), key = ref.kind === 'preset' ? 'promptGroups' : 'regexGroups';
    const own = () => ref.scope === 'global' ? c.extensionSettings[NS]?.regexScopes?.global : ext[NS]?.[key];
    const state = own(), group = state?.groups?.find((g: Raw) => g.id === id);
    if (!group || state.version !== 1) throw new Error('分组已变更，请重新打开');
    const changes: { locate: () => Raw | undefined; before: any; present: boolean }[] = [];
    const update = (locate: () => Raw | undefined) => {
      const value = locate(); if (!value) return;
      changes.push({ locate, before: value.enabled, present: Object.hasOwn(value, 'enabled') }); value.enabled = enabled;
    };
    update(() => own()?.groups?.find((g: Raw) => g.id === id));
    if (ref.kind === 'preset' && state.sync?.includes('baibai') && !state.suppressed?.includes('baibai'))
      update(() => ext.baibaiToolkit?.presetPromptGroups?.groups?.find((g: Raw) => g.id === id));
    const signal = () => { if (typeof document !== 'undefined') document.dispatchEvent(new Event('prw:runtime-sync')); };
    const persist = async () => {
      if (ref.scope === 'scoped') await this.writeCharacter(ref, { [NS]: clone(ext[NS]) });
      else await module.saveSettings();
    };
    signal();
    try { await persist(); }
    catch (error) {
      for (const change of changes) {
        const value = change.locate(); if (!value || value.enabled !== enabled) continue;
        if (change.present) value.enabled = change.before; else delete value.enabled;
      }
      signal();
      try { await persist(); }
      catch { throw new Error(`组开关保存和恢复均失败，请重新载入。${String(error)}`); }
      throw error;
    }
    signal();
    return true;
  }
  resources(kind: Kind): Resource[] {
    const c = ctx(),
      m = getManager();
    const names = Object.keys(m.getPresetList().preset_names).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const list: Resource[] = names.map(name => ({
      key: `${kind}:preset:${name}`,
      label: name,
      kind,
      scope: 'preset',
      name,
    }));
    if (kind === 'preset') {
      const name = m.getSelectedPresetName();
      if (name)
        list.unshift({ key: 'preset:live', label: `${name} · 使用中`, name, kind, scope: 'preset', live: true });
    } else {
      const name = m.getSelectedPresetName();
      if (name)
        list.unshift({ key: 'regex:preset:live', label: `${name} · 使用中`, name, kind, scope: 'preset', live: true });
      const characters = c.characters.map((ch: Raw, index: number) => ({ ch, index }))
        .filter(({ ch }: any) => !!ch.avatar).sort((a: any, b: any) =>
          Number(b.index === Number(c.characterId)) - Number(a.index === Number(c.characterId)) || String(a.ch.name || a.ch.avatar).localeCompare(String(b.ch.name || b.ch.avatar), 'zh-CN'));
      const nameCounts = new Map<string, number>();
      for (const { ch } of characters) nameCounts.set(ch.name, (nameCounts.get(ch.name) || 0) + 1);
      list.unshift(...characters.map(({ ch, index }: any) => ({
          key: `regex:scoped:${ch.avatar}`,
          label: `角色 · ${ch.name || ch.avatar}${(nameCounts.get(ch.name) || 0) > 1 ? `（${ch.avatar}）` : ''}`,
          kind,
          scope: 'scoped',
          characterId: index,
          current: index === Number(c.characterId),
          avatar: ch.avatar,
        } as Resource)));
      list.unshift({ key: 'regex:global', label: '全局正则', kind, scope: 'global' });
    }
    return list;
  }
  async load(ref: Resource): Promise<Snapshot> {
    const c = ctx(),
      settings = c.extensionSettings;
    if (ref.kind === 'preset') {
      const raw = clone(presetRaw(ref)),
        ext = raw.extensions || {};
      return {
        raw,
        ...(ref.live ? { file: await this.load({ ...ref, live: false }) } : {}),
        own: ownGroups(ext, 'promptGroups'),
        ...(ext[LEGACY_NS]?.promptGroups === undefined ? {} : { namespace: { current: clone(ext[NS]?.promptGroups), legacy: clone(ext[LEGACY_NS].promptGroups) } }),
        ...(legacyConflict(ext[NS]?.promptGroups, ext[LEGACY_NS]?.promptGroups) === undefined ? {} :
          { legacyOwn: legacyConflict(ext[NS]?.promptGroups, ext[LEGACY_NS]?.promptGroups) }),
        baibai: ext.baibaiToolkit?.presetPromptGroups,
        transfer: ext.entryGrouping,
      };
    }
    const ext = ref.scope === 'scoped' ? await this.characterExtensions(ref) : rawExtensions(ref);
    const raw = ref.scope === 'global' ? settings.regex || [] : ext.regex_scripts || [];
    return clone({
      raw,
      ...(ref.live ? { file: await this.load({ ...ref, live: false }) } : {}),
      ...((ref.scope === 'global' ? settings[LEGACY_NS]?.regexScopes?.global : ext[LEGACY_NS]?.regexGroups) === undefined ? {} : {
        namespace: { current: ref.scope === 'global' ? settings[NS]?.regexScopes?.global : ext[NS]?.regexGroups,
          legacy: ref.scope === 'global' ? settings[LEGACY_NS]?.regexScopes?.global : ext[LEGACY_NS]?.regexGroups },
      }),
      own: ref.scope === 'global' ? globalGroups(settings) : ownGroups(ext, 'regexGroups'),
      ...(legacyConflict(ref.scope === 'global' ? settings[NS]?.regexScopes?.global : ext[NS]?.regexGroups,
        ref.scope === 'global' ? settings[LEGACY_NS]?.regexScopes?.global : ext[LEGACY_NS]?.regexGroups) === undefined ? {} :
        { legacyOwn: legacyConflict(ref.scope === 'global' ? settings[NS]?.regexScopes?.global : ext[NS]?.regexGroups,
          ref.scope === 'global' ? settings[LEGACY_NS]?.regexScopes?.global : ext[LEGACY_NS]?.regexGroups) }),
      baibai:
        (ref.scope === 'preset' ? ext.baibaiToolkit?.regexGroups : undefined) ??
        settings.baiBaiToolkit?.regexListGroups?.scopes?.[regexKey(ref)],
      transfer: settings.presetTransfer?.regexScriptGroupings,
    });
  }
  private validateActive(doc: WorkDocument) {
    const ref = doc.ref;
    if (ref.scope !== 'preset' || ref.live) return;
    const m = getManager();
    if (m.getSelectedPresetName() !== ref.name) return;
    assertPresetReady();
    const live = m.getPresetList().settings,
      saved = m.getCompletionPresetByName(ref.name);
    const fields = ref.kind === 'preset' ? ['prompts', 'prompt_order'] : [];
    for (const field of fields) {
      if (stable(live[field]) !== stable(saved[field]))
        throw new Error(`“${ref.label}”有未保存修改，请先在酒馆保存，或编辑“使用中”版本`);
    }
    const a = live.extensions || {},
      b = saved.extensions || {};
    const ownKey = ref.kind === 'preset' ? 'promptGroups' : 'regexGroups',
      baiKey = ref.kind === 'preset' ? 'presetPromptGroups' : 'regexGroups';
    if (
      stable([
        ownGroups(a, ownKey), a[LEGACY_NS]?.[ownKey],
        a.baibaiToolkit?.[baiKey],
        ref.kind === 'preset' ? a.entryGrouping : a.regex_scripts,
      ]) !==
      stable([ownGroups(b, ownKey), b[LEGACY_NS]?.[ownKey], b.baibaiToolkit?.[baiKey], ref.kind === 'preset' ? b.entryGrouping : b.regex_scripts])
    )
      throw new Error(`“${ref.label}”有未保存修改，请选择“使用中”版本`);
  }
  private validateCompatibility(doc: WorkDocument) {
    if (
      doc.ref.kind !== 'regex' ||
      doc.ref.scope === 'global' ||
      (!doc.providerGroups?.transfer && !doc.cleanup.includes('transfer') &&
        (!doc.state.sync.includes('transfer') || doc.state.suppressed.includes('transfer')))
    )
      return;
    const ids = new Set([...doc.entries.map(e => e.id), ...doc.snapshot.raw.map((r: Raw) => String(r.id))]);
    const others =
      doc.ref.scope === 'preset'
        ? Object.entries(getManager().getPresetList().preset_names)
            .filter(([name]) => name !== doc.ref.name)
            .map(([name]) => getManager().getCompletionPresetByName(name)?.extensions?.regex_scripts || [])
        : ctx()
            .characters.filter((c: Raw) => c.avatar !== doc.ref.avatar)
            .map((c: Raw) => c.data?.extensions?.regex_scripts || []);
    if (others.some((rows: Raw[]) => rows.some(r => ids.has(String(r.id)))))
      throw new Error('其他资源也在使用相同的正则ID，无法单独写回或清理转移工具分组。请取消这项，工坊分组仍可保存。');
  }
  private async persist(ref: Resource, snapshot: Snapshot, doc?: WorkDocument, restore = false) {
    const c = ctx(),
      settings = c.extensionSettings;
    if (ref.kind === 'preset' || ref.scope === 'preset') {
      if (ref.live) {
        const m = getManager(), file = restore ? snapshot.file || snapshot : snapshot;
        const raw = clone(m.getCompletionPresetByName(ref.name));
        if (!raw || !Array.isArray(raw.prompts)) throw new Error('目标预设文件已不存在');
        if (ref.kind === 'preset') {
          raw.prompts = clone(file.raw.prompts); raw.prompt_order = clone(file.raw.prompt_order);
        }
        raw.extensions ||= {};
        if (ref.kind === 'regex') raw.extensions.regex_scripts = clone(file.raw);
        groupFields(raw.extensions, file, ref.kind, restore);
        await m.savePreset(ref.name, raw, { skipUpdate: true });
        const cached = m.getCompletionPresetByName(ref.name);
        if (cached !== m.getPresetList().settings) assignObject(cached, raw);
        if (m.getSelectedPresetName() === ref.name) {
          const live = m.getPresetList().settings;
          if (ref.kind === 'preset') for (const key of ['prompts', 'prompt_order'])
            if (stable(live[key]) !== stable(snapshot.raw[key])) live[key] = clone(snapshot.raw[key]);
          live.extensions ||= {};
          if (ref.kind === 'regex' && stable(live.extensions.regex_scripts) !== stable(snapshot.raw)) live.extensions.regex_scripts = clone(snapshot.raw);
          groupFields(live.extensions, snapshot, ref.kind, restore);
        } else if (!restore) throw new Error('预设已切换，保存已停止并将恢复');
        const module = await this.moduleLoader('/script.js');
        await module.saveSettings();
        return;
      }
      const m = getManager(),
        raw = clone(presetRaw(ref));
      if (ref.kind === 'preset') {
        raw.prompts = clone(snapshot.raw.prompts);
        raw.prompt_order = clone(snapshot.raw.prompt_order);
      }
      const ext = (raw.extensions ||= {});
      if (ref.kind === 'regex') ext.regex_scripts = clone(snapshot.raw);
      groupFields(ext, snapshot, ref.kind, restore);
      if (ref.live) {
        const target = presetRaw(ref);
        for (const key of ['prompts', 'prompt_order', 'extensions']) target[key] = clone(raw[key]);
      } else {
        await m.savePreset(ref.name, raw, { skipUpdate: true });
        assignObject(m.getCompletionPresetByName(ref.name), raw);
        if (m.getSelectedPresetName() === ref.name) {
          const live = m.getPresetList().settings;
          if (ref.kind === 'preset') for (const key of ['prompts', 'prompt_order']) live[key] = clone(raw[key]);
          live.extensions ||= {};
          if (ref.kind === 'regex') live.extensions.regex_scripts = clone(snapshot.raw);
          groupFields(live.extensions, snapshot, ref.kind, restore);
        }
      }
    } else if (ref.scope === 'scoped') {
      const ext = await this.characterExtensions(ref, true);
      const own = { ...(ext[NS] || {}), regexGroups: clone(snapshot.own) };
      if (snapshot.own === undefined) delete own.regexGroups;
      if (restore && snapshot.namespace) {
        if (snapshot.namespace.current === undefined) delete own.regexGroups;
        else own.regexGroups = clone(snapshot.namespace.current);
      }
      const legacy = clone(ext[LEGACY_NS] || {}); delete legacy.regexGroups;
      if (restore && snapshot.namespace?.legacy !== undefined) legacy.regexGroups = clone(snapshot.namespace.legacy);
      await this.writeCharacter(ref, { regex_scripts: clone(snapshot.raw), [NS]: Object.keys(own).length ? own : undefined,
        ...(snapshot.namespace || ext[LEGACY_NS] ? { [LEGACY_NS]: Object.keys(legacy).length ? legacy : undefined } : {}) });
    } else {
      if (!Array.isArray(settings.regex)) settings.regex = [];
      assignArray(settings.regex, snapshot.raw);
      settings[NS] ||= {};
      settings[NS].regexScopes ||= {};
      settings[NS].regexScopes[regexKey(ref)] = clone(snapshot.own);
      if (settings[LEGACY_NS]?.regexScopes) {
        delete settings[LEGACY_NS].regexScopes[regexKey(ref)];
        if (!Object.keys(settings[LEGACY_NS].regexScopes).length) clearLegacyField(settings, 'regexScopes');
      }
      if (restore && snapshot.namespace) {
        if (snapshot.namespace.current === undefined) delete settings[NS].regexScopes[regexKey(ref)];
        else settings[NS].regexScopes[regexKey(ref)] = clone(snapshot.namespace.current);
        if (snapshot.namespace.legacy !== undefined) {
          settings[LEGACY_NS] ||= {}; settings[LEGACY_NS].regexScopes ||= {};
          settings[LEGACY_NS].regexScopes[regexKey(ref)] = clone(snapshot.namespace.legacy);
        }
      }
    }
    if (ref.kind === 'regex') {
      // Never replace the whole shared transfer store with a stale per-document copy.
      const key = regexKey(ref);
      if (snapshot.baibai !== undefined) {
        settings.baiBaiToolkit ||= {};
        settings.baiBaiToolkit.regexListGroups ||= { scopes: {} };
        settings.baiBaiToolkit.regexListGroups.scopes ||= {};
        settings.baiBaiToolkit.regexListGroups.scopes[key] = clone(snapshot.baibai);
      } else if (settings.baiBaiToolkit?.regexListGroups?.scopes)
        delete settings.baiBaiToolkit.regexListGroups.scopes[key];
      const touchesTransfer =
        !!doc &&
        (doc.providerGroups?.transfer !== undefined || doc.cleanup.includes('transfer') ||
          (doc.state.sync.includes('transfer') && !doc.state.suppressed.includes('transfer')));
      if (touchesTransfer || (!doc && snapshot.transfer !== undefined)) {
        settings.presetTransfer ||= {};
        const transferDoc = doc?.providerGroups?.transfer
          ? { ...doc, state: { ...doc.state, groups: doc.providerGroups.transfer } } : doc;
        const value = transferDoc
          ? transformTransfer(transferDoc, settings.presetTransfer.regexScriptGroupings, transferDoc.cleanup.includes('transfer'))
          : snapshot.transfer;
        settings.presetTransfer.regexScriptGroupings = clone(value);
        localStorage.setItem('preset-transfer-regex-script-groupings-v2', JSON.stringify(value));
      }
    }
    const module = await this.moduleLoader('/script.js');
    await module.saveSettings();
  }
  async commit(items: { doc: WorkDocument; snapshot: Snapshot }[]) {
    const before = new Map<string, Snapshot>();
    for (const { doc } of items) {
      this.validateActive(doc);
      this.validateCompatibility(doc);
      const current = await this.load(doc.ref);
      if (stable(current) !== doc.baseline) throw new Error(`“${doc.ref.label}”已在别处修改，请先重新载入`);
      before.set(doc.ref.key, current);
    }
    const named = new Set(items.filter(i => i.doc.ref.scope === 'preset' && !i.doc.ref.live).map(i => i.doc.ref.name));
    if (items.some(i => i.doc.ref.live && named.has(i.doc.ref.name)))
      throw new Error('同一个预设的已保存版和使用中版本不能一起保存');
    const attempted: typeof items = [];
    try {
      // Targets are supplied before sources for cross-resource moves.
      for (const item of items) {
        attempted.push(item);
        await this.persist(item.doc.ref, item.snapshot, item.doc);
      }
    } catch (error) {
      const failed: string[] = [];
      for (const item of attempted.reverse()) {
        try {
          await this.persist(item.doc.ref, before.get(item.doc.ref.key)!, undefined, true);
        } catch {
          failed.push(item.doc.ref.label);
        }
      }
      if (failed.length)
        throw new Error(
          `保存失败，以下资源恢复失败：${failed.join('、')}。草稿仍保留，请导出备份。原错误：${String(error)}`,
        );
      throw error;
    }
  }
  async refresh(refs: Resource[]) {
    const c = ctx();
    if (refs.some(r => r.scope === 'preset' && r.name === getManager().getSelectedPresetName())) {
      const mod = await this.moduleLoader('/scripts/openai.js');
      await mod.promptManager?.render?.();
    }
    if (!refs.some(r => r.kind === 'regex' && (r.scope === 'global' ||
      (r.scope === 'scoped' ? r.avatar === c.characters[c.characterId]?.avatar : r.name === getManager().getSelectedPresetName())))) return;
    const toggle = document.querySelector<HTMLInputElement>('#bai_bai_toolkit_regex_quick_operation_enabled');
    if (toggle?.checked) toggle.dispatchEvent(new Event('input', { bubbles: true }));
    else {
      const listeners = c.eventSource.events?.[c.eventTypes.CHAT_CHANGED] || [];
      const fn = listeners.find((f: any) => f.name === 'checkCharEmbeddedRegexScripts');
      if (fn) await fn();
    }
  }
  async edit(ref: Resource, id: string) {
    if (!this.resources(ref.kind).some(r => r.key === ref.key && r.name === ref.name && r.avatar === ref.avatar))
      throw new Error('当前预设或角色已切换，请重试');
    if (ref.kind === 'preset') {
      if (getManager().getSelectedPresetName() !== ref.name) throw new Error('预设已切换，请重试');
      const mod = await this.moduleLoader('/scripts/openai.js');
      if (!mod.promptManager?.handleEdit) throw new Error('当前酒馆没有原生预设编辑接口');
      const row = document.createElement('div'); row.className = `${mod.promptManager.configuration?.prefix || 'completion_'}prompt_manager_prompt`; row.dataset.pmIdentifier = id;
      const target = document.createElement('button'); row.append(target);
      mod.promptManager.handleEdit({ target });
      return;
    }
    if (ref.scope === 'scoped' && ref.avatar !== ctx().characters[ctx().characterId]?.avatar) return false;
    const root = document.querySelector(ref.scope === 'global' ? '#saved_regex_scripts' : ref.scope === 'scoped' ? '#saved_scoped_scripts' : '#saved_preset_scripts');
    const row = [...root?.querySelectorAll<HTMLElement>('.regex-script-label') || []].find(e => (e.dataset.regexScriptId || e.id) === id);
    const button = row?.querySelector<HTMLElement>('.edit_existing_regex');
    if (!button) return false;
    button.click();
  }
}
export async function saveDocuments(
  host: Host,
  documents: WorkDocument[],
  saveOrder: string[] = [],
  options: { preserveRaw?: boolean; orderOnly?: boolean } = {},
): Promise<WorkDocument[]> {
  const dirty = documents
    .filter(d => d.dirty)
    .sort((a, b) => {
      const ia = saveOrder.indexOf(a.ref.key),
        ib = saveOrder.indexOf(b.ref.key);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  if (!dirty.length) return [];
  await host.commit(dirty.map(doc => {
    const snapshot = serialize(doc);
    if (options.preserveRaw) snapshot.raw = clone(doc.snapshot.raw);
    if (options.orderOnly) {
      snapshot.raw = clone(doc.snapshot.raw);
      snapshot.own = clone(doc.snapshot.own);
      if (doc.ref.kind === 'regex') {
        const originals = new Map(snapshot.raw.map((r: Raw) => [String(r.id), r]));
        snapshot.raw = doc.entries.map(e => originals.get(e.id));
      } else {
        const order = orderOf(snapshot.raw), originals = new Map(order.map(r => [String(r.identifier), r]));
        order.splice(0, order.length, ...doc.entries.map(e => originals.get(e.id)!));
      }
    }
    return { doc, snapshot };
  }));
  // Reload all snapshots after all shared group stores have been committed.
  const result = await Promise.all(dirty.map(async d => makeDocument(d.ref, await host.load(d.ref))));
  try {
    await host.refresh(dirty.map(d => d.ref));
  } catch (error) {
    console.warn('[Cの炼金工坊] 已保存，原面板刷新失败', error);
  }
  if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function')
    document.dispatchEvent(new CustomEvent('prw:resources-saved', { detail: dirty.map(d => d.ref) }));
  return result;
}
