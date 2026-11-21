import { readPreferences } from './preferences';
import { NativeHost } from './native';
import type { Raw } from './types';

const nativeModule = (path: string): Promise<any> => import(/* webpackIgnore: true */ new URL(path, location.href).href);
interface Target {
  key: string;
  scripts: Raw[];
  save: (changes: Map<string, boolean>) => Promise<void>;
  allow: () => void;
}

/** Keep native flags current while deferring the expensive list/chat refresh until the drawer closes. */
export function installRegexRefresh(load = nativeModule) {
  const host = new NativeHost(load);
  const signal = new AbortController();
  const context = () => window.SillyTavern?.getContext?.();
  let enabled = false, stopped = false, engine: any;
  let panel: HTMLElement | undefined, observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, saving: Promise<void> | undefined;
  let needsRefresh = false, refreshing = false, finishAgain = false, chatId: string | undefined;
  const pending = new Map<string, { target: Target; changes: Map<string, boolean> }>();

  function target(listId: string): Target | undefined {
    const c = context();
    const scope = { saved_regex_scripts: 'GLOBAL', saved_preset_scripts: 'PRESET', saved_scoped_scripts: 'SCOPED' }[listId];
    if (!scope || !engine || !c) return;
    const scripts = engine.getScriptsByType(engine.SCRIPT_TYPES[scope]);
    if (!Array.isArray(scripts)) return;
    if (scope === 'GLOBAL') {
      if (!c.saveSettingsDebounced) return;
      return { key: 'global', scripts, allow() {}, save: async () => c.saveSettingsDebounced() };
    }
    if (scope === 'PRESET') {
      const manager = c.getPresetManager?.(), name = manager?.getSelectedPresetName?.();
      if (!name || !manager.writePresetExtensionField || !manager.readPresetExtensionField || !engine.allowPresetScripts) return;
      return { key: JSON.stringify([manager.apiId, name]), scripts,
        allow: () => engine.allowPresetScripts(manager.apiId, name),
        save: async changes => {
          const path = 'regex_scripts';
          const latest = manager.readPresetExtensionField({ name, path });
          if (!Array.isArray(latest)) throw new Error('预设正则已变化');
          for (const script of latest) if (changes.has(script.id)) script.disabled = changes.get(script.id);
          await manager.writePresetExtensionField({ name, path, value: latest });
        } };
    }
    const ch = c.characters?.[c.characterId];
    if (!ch?.avatar || !engine.allowScopedScripts || !c.getRequestHeaders) return;
    const avatar = ch.avatar;
    return { key: 'character:' + avatar, scripts, allow: () => engine.allowScopedScripts(ch),
      save: changes => host.saveCharacterRegexFlags(avatar, changes) };
  }
  function report(error: unknown) {
    console.error('[Cの炼金工坊] 正则开关', error);
    (window as any).toastr?.error?.(String(error), '正则开关', { escapeHtml: true });
  }
  async function persist() {
    clearTimeout(timer);
    if (saving) { await saving; if (pending.size) await persist(); return; }
    if (!pending.size) return;
    const run = async () => {
      while (pending.size) {
        const [key, batch] = pending.entries().next().value!;
        pending.delete(key);
        try { await batch.target.save(batch.changes); }
        catch (error) {
          const newer = pending.get(key);
          if (newer) for (const [id, value] of newer.changes) batch.changes.set(id, value);
          pending.set(key, batch);
          throw error;
        }
      }
    };
    saving = run();
    try { await saving; } finally { saving = undefined; }
  }
  function visible() {
    return panel?.isConnected && panel.getClientRects().length && !panel.closest('.closedDrawer,[hidden],dialog:not([open])');
  }
  async function finish() {
    if (!needsRefresh) return;
    if (refreshing) { finishAgain = true; return; }
    refreshing = true;
    try {
      await persist();
      if (stopped || (enabled && visible())) return;
      needsRefresh = false;
      observer?.disconnect();
      const c = context(), current = c?.getCurrentChatId?.();
      if (current && current === chatId) await c.reloadCurrentChat();
      else if (!current) {
        const handlers = c?.eventSource?.events?.[c.eventTypes?.CHAT_CHANGED] || [];
        await handlers.find((fn: Function) => fn.name === 'checkCharEmbeddedRegexScripts')?.();
      }
    } catch (error) { report(error); }
    finally {
      refreshing = false;
      if (finishAgain) { finishAgain = false; void finish(); }
    }
  }
  function watchPanel(input: HTMLElement) {
    const next = input.closest<HTMLElement>('.regex_settings .inline-drawer-content') || input.closest<HTMLElement>('#regex_container');
    if (!next) return;
    panel = next;
    observer?.disconnect();
    let wasVisible = true;
    observer = new MutationObserver(() => {
      const open = Boolean(visible());
      if (wasVisible && !open) void finish();
      wasVisible = open;
    });
    for (let el: HTMLElement | null = next; el; el = el.parentElement)
      observer.observe(el, { attributes: true, attributeFilter: ['class','style','hidden','open'], childList: true });
  }
  function onToggle(event: Event) {
    if (!enabled || !engine?.getScriptsByType || !engine.SCRIPT_TYPES || !(event.target instanceof Element)) return;
    const icon = event.target.closest('.regex-toggle-on,.regex-toggle-off');
    if (event.type === 'click' ? !icon : !event.target.matches('input.disable_regex')) return;
    const row = event.target.closest<HTMLElement>('#regex_container .regex-script-label');
    const input = row?.querySelector<HTMLInputElement>('input.disable_regex');
    const list = row?.closest('#saved_regex_scripts,#saved_scoped_scripts,#saved_preset_scripts');
    if (!input || !row || !list) return;
    const dest = target(list.id), id = row.dataset.regexScriptId || row.id;
    const script = dest?.scripts.find(item => item.id === id);
    if (!dest || !script) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const disabled = icon ? icon.classList.contains('regex-toggle-on') : input.checked;
    input.checked = disabled;
    script.disabled = disabled;
    dest.allow();
    const batch = pending.get(dest.key) || { target: dest, changes: new Map<string, boolean>() };
    batch.changes.set(id, disabled);
    pending.set(dest.key, batch);
    if (!needsRefresh || panel !== input.closest('.inline-drawer-content') || !visible()) watchPanel(input);
    needsRefresh = true;
    chatId = context()?.getCurrentChatId?.();
    clearTimeout(timer);
    timer = setTimeout(() => { void persist().catch(report); }, 160);
  }
  function configure() {
    enabled = readPreferences().regexDeferredRefresh;
    if (enabled && !engine) void load('/scripts/extensions/regex/engine.js').then(value => { engine = value; }).catch(report);
    if (!enabled) void finish();
  }
  for (const event of ['click','input']) document.addEventListener(event, onToggle, { capture: true, signal: signal.signal });
  document.addEventListener('prw:regex-refresh-preference', configure, { signal: signal.signal });
  configure();
  return () => { stopped = true; enabled = false; signal.abort(); observer?.disconnect(); void finish(); };
}
