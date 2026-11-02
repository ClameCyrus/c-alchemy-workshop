import { clone, makeDocument, NS, serialize, stable, transformTransfer } from './core';
import type { Host, Kind, Raw, Resource, Snapshot, WorkDocument } from './types';

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
  const m = getManager();
  const value = ref.live ? m.getPresetList().settings : m.getCompletionPresetByName(ref.name);
  if (!value || !Array.isArray(value.prompts)) throw new Error('预设不存在或格式不支持');
  if (ref.live && m.getSelectedPresetName() !== ref.name) throw new Error('当前预设已切换，请重新打开');
  return value;
}
function character(ref: Resource): Raw {
  const value = ctx().characters[ref.characterId!];
  if (!value || value.avatar !== ref.avatar) throw new Error('角色已变更，请重新打开');
  return value;
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
function groupFields(ext: Raw, snapshot: Snapshot, kind: Kind) {
  const ownKey = kind === 'preset' ? 'promptGroups' : 'regexGroups';
  const baiKey = kind === 'preset' ? 'presetPromptGroups' : 'regexGroups';
  for (const [namespace, key, value] of [
    [NS, ownKey, snapshot.own],
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
  constructor(private moduleLoader: (path: string) => Promise<any> = nativeModule) {}
  async setGroupEnabled(ref: Resource, id: string, enabled: boolean) {
    // Native views refer to live resources; named files still use the normal guarded save path.
    if (ref.scope === 'preset' && !ref.live) return false;
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
      if (ref.scope === 'scoped') await c.writeExtensionField(ref.characterId, NS, clone(ext[NS]));
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
      const ch = c.characters[c.characterId];
      if (ch)
        list.unshift({
          key: `regex:scoped:${ch.avatar}`,
          label: `角色 · ${ch.name}`,
          kind,
          scope: 'scoped',
          characterId: Number(c.characterId),
          avatar: ch.avatar,
        });
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
        own: ext[NS]?.promptGroups,
        baibai: ext.baibaiToolkit?.presetPromptGroups,
        transfer: ext.entryGrouping,
      };
    }
    const ext = rawExtensions(ref);
    const raw = ref.scope === 'global' ? settings.regex || [] : ext.regex_scripts || [];
    return clone({
      raw,
      own: ref.scope === 'global' ? settings[NS]?.regexScopes?.[regexKey(ref)] : ext[NS]?.regexGroups,
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
        a[NS]?.[ownKey],
        a.baibaiToolkit?.[baiKey],
        ref.kind === 'preset' ? a.entryGrouping : a.regex_scripts,
      ]) !==
      stable([b[NS]?.[ownKey], b.baibaiToolkit?.[baiKey], ref.kind === 'preset' ? b.entryGrouping : b.regex_scripts])
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
  private async persist(ref: Resource, snapshot: Snapshot, doc?: WorkDocument) {
    const c = ctx(),
      settings = c.extensionSettings;
    if (ref.kind === 'preset' || ref.scope === 'preset') {
      const m = getManager(),
        raw = clone(presetRaw(ref));
      if (ref.kind === 'preset') {
        raw.prompts = clone(snapshot.raw.prompts);
        raw.prompt_order = clone(snapshot.raw.prompt_order);
      }
      const ext = (raw.extensions ||= {});
      if (ref.kind === 'regex') ext.regex_scripts = clone(snapshot.raw);
      groupFields(ext, snapshot, ref.kind);
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
          groupFields(live.extensions, snapshot, ref.kind);
        }
      }
    } else if (ref.scope === 'scoped') {
      const ch = character(ref),
        ext = (ch.data.extensions ||= {});
      const own = { ...(ext[NS] || {}), regexGroups: clone(snapshot.own) };
      await c.writeExtensionField(ref.characterId, 'regex_scripts', clone(snapshot.raw));
      await c.writeExtensionField(ref.characterId, NS, own);
      ext.regex_scripts = clone(snapshot.raw);
      ext[NS] = own;
    } else {
      if (!Array.isArray(settings.regex)) settings.regex = [];
      assignArray(settings.regex, snapshot.raw);
      settings[NS] ||= {};
      settings[NS].regexScopes ||= {};
      settings[NS].regexScopes[regexKey(ref)] = clone(snapshot.own);
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
          await this.persist(item.doc.ref, before.get(item.doc.ref.key)!);
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
    if (!refs.some(r => r.kind === 'regex')) return;
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
): Promise<WorkDocument[]> {
  const dirty = documents
    .filter(d => d.dirty)
    .sort((a, b) => {
      const ia = saveOrder.indexOf(a.ref.key),
        ib = saveOrder.indexOf(b.ref.key);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  if (!dirty.length) return [];
  await host.commit(dirty.map(doc => ({ doc, snapshot: serialize(doc) })));
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
