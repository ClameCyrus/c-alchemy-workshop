import { globalGroups, ownGroups, pausedMembers } from './core';
import type { GroupState, Raw } from './types';
import { groupingEnabled } from './preferences';

export const nativeGrouping = (state?: Partial<GroupState>) => !!state?.groups?.length;

/** The engine has no per-script filter hook. Restrict the runtime overlay to its native disabled check. */
export function nativeRegexRead(stack = new Error().stack || '') {
  const lines = stack.split('\n');
  const index = lines.findIndex(line => /\brunRegexScript(?:\s*\(|@)/.test(line) && line.includes('/scripts/extensions/regex/engine.js'));
  return index >= 0 && !lines.slice(0, index).some(line => /JSON\.stringify|structuredClone|\.toJSON\b/.test(line));
}

export function gateRegexFlag(script: Raw, paused: () => boolean, executing = nativeRegexRead) {
  const descriptor = Object.getOwnPropertyDescriptor(script, 'disabled');
  if (descriptor && !descriptor.configurable) throw new Error('正则开关属性无法添加运行时分组控制');
  let value = descriptor?.get ? descriptor.get.call(script) : descriptor?.value;
  let written = false;
  const read = () => descriptor?.get ? descriptor.get.call(script) : value;
  const get = () => {
    const original = read();
    if (original) return original;
    return paused() && executing() ? true : original;
  };
  const set = (next: unknown) => {
    if (descriptor?.set) descriptor.set.call(script, next);
    else {
      if (descriptor && descriptor.writable === false) throw new TypeError('正则开关不可写');
      value = next;
    }
    written = true;
  };
  Object.defineProperty(script, 'disabled', { configurable: true, enumerable: descriptor?.enumerable ?? true, get, set });
  return () => {
    if (Object.getOwnPropertyDescriptor(script, 'disabled')?.get !== get) return;
    if (descriptor?.get || descriptor?.set) Object.defineProperty(script, 'disabled', descriptor);
    else if (descriptor) Object.defineProperty(script, 'disabled', { ...descriptor, value });
    else { delete script.disabled; if (written) script.disabled = value; }
  };
}

export function gatePromptCollection(collection: any, blocked: Set<string>) {
  if (!collection || !blocked.size) return collection;
  const allowed = (p: Raw) => !blocked.has(p?.identifier) ? p : p.identifier === 'main'
    ? Object.assign(Object.create(Object.getPrototypeOf(p)), p, { content: '' }) : undefined;
  if (Array.isArray(collection.collection)) collection.collection = collection.collection.map(allowed).filter(Boolean);
  for (const name of ['add', 'set', 'override']) {
    const original = collection[name];
    if (typeof original !== 'function') continue;
    collection[name] = function (...args: any[]) {
      if (name === 'add') return original.apply(this, args.map(allowed).filter(Boolean));
      if (blocked.has(args[0]?.identifier)) { const prompt = allowed(args[0]); if (!prompt) return; args[0] = prompt; }
      return original.apply(this, args);
    };
  }
  return collection;
}

export function installGroupRuntime(loadModule: (path: string) => Promise<any> = path => import(/* webpackIgnore: true */ new URL(path, location.href).href)) {
  let enabled = groupingEnabled();
  let stopped = false, scheduled = false, engine: any, openai: any;
  let wanted = new Set<Raw>();
  const bindings = new Map<Raw, () => void>();
  let promptPatch: { manager: any; get: any; disabled: any; prepare: any; originalGet: any; originalDisabled: any; originalPrepare: any } | undefined;
  const context = () => window.SillyTavern?.getContext?.();
  const promptState = () => ownGroups(context()?.getPresetManager('openai')?.getPresetList().settings?.extensions, 'promptGroups');
  let lastPromptState: any, promptBlocked = new Set<string>();
  function promptPlan() {
    const state = promptState();
    if (state !== lastPromptState) { lastPromptState = state; promptBlocked = pausedMembers(state); }
    return { active: enabled && nativeGrouping(state), blocked: promptBlocked };
  }
  function sync() {
    if (stopped || !engine) return;
    const c = context(); if (!c) return;
    const manager = c.getPresetManager('openai'), live = manager?.getPresetList().settings;
    const ch = c.characters?.[c.characterId];
    wanted = new Set();
    for (const [type, state] of [
      [engine.SCRIPT_TYPES.GLOBAL, globalGroups(c.extensionSettings)],
      [engine.SCRIPT_TYPES.PRESET, ownGroups(live?.extensions, 'regexGroups')],
      [engine.SCRIPT_TYPES.SCOPED, ownGroups(ch?.data?.extensions, 'regexGroups')],
    ]) {
      if (!enabled || !nativeGrouping(state)) continue;
      const blocked = pausedMembers(state);
      if (blocked.size) for (const script of engine.getScriptsByType(type)) if (blocked.has(String(script.id))) wanted.add(script);
    }
    for (const [script, restore] of bindings) if (!wanted.has(script)) { restore(); bindings.delete(script); }
    for (const script of wanted) if (!bindings.has(script)) {
      try { bindings.set(script, gateRegexFlag(script, () => !stopped && wanted.has(script))); }
      catch (error) { console.error('[Cの炼金工坊] 无法暂停正则', script.scriptName, error); }
    }
    lastPromptState = promptState(); promptBlocked = pausedMembers(lastPromptState);
    const pm = openai?.promptManager;
    if (typeof pm?.getPromptCollection !== 'function' || typeof pm.isPromptDisabledForActiveCharacter !== 'function' ||
        (promptPatch && promptPatch.manager === pm && pm.getPromptCollection === promptPatch.get && pm.isPromptDisabledForActiveCharacter === promptPatch.disabled && pm.preparePrompt === promptPatch.prepare)) return;
    const originalGet = promptPatch && promptPatch.manager === pm && pm.getPromptCollection === promptPatch.get ? promptPatch.originalGet : pm.getPromptCollection;
    const originalDisabled = promptPatch && promptPatch.manager === pm && pm.isPromptDisabledForActiveCharacter === promptPatch.disabled ? promptPatch.originalDisabled : pm.isPromptDisabledForActiveCharacter;
    const originalPrepare = promptPatch && promptPatch.manager === pm && pm.preparePrompt === promptPatch.prepare ? promptPatch.originalPrepare : pm.preparePrompt;
    const prepare = function (this: any, prompt: Raw, ...args: any[]) {
      const plan = promptPlan();
      // substituteParams executes setvar before the collection is filtered.
      // Sanitize a disposable input, leaving stored content and switches intact.
      if (!stopped && plan.active && plan.blocked.has(prompt?.identifier)) {
        prompt = { ...prompt, content: '' };
        if (typeof args[0] === 'string') args[0] = '';
      }
      return originalPrepare.call(this, prompt, ...args);
    };
    const get = function (this: any, ...args: any[]) {
      const plan = promptPlan();
      if (stopped || !plan.active) return originalGet.apply(this, args);
      const base = originalGet.__baiBaiToolkitOriginalGetPromptCollection || originalGet;
      return gatePromptCollection(base.apply(this, args), plan.blocked);
    };
    const disabled = function (this: any, id: string, ...args: any[]) {
      const plan = promptPlan();
      const base = !stopped && plan.active
        ? originalDisabled.__baiBaiToolkitOriginalIsPromptDisabledForActiveCharacter || originalDisabled : originalDisabled;
      return base.call(this, id, ...args) || (!stopped && plan.active && plan.blocked.has(id));
    };
    pm.getPromptCollection = get; pm.isPromptDisabledForActiveCharacter = disabled;
    if (typeof originalPrepare === 'function') pm.preparePrompt = prepare;
    promptPatch = { manager: pm, get, disabled, prepare: pm.preparePrompt, originalGet, originalDisabled, originalPrepare };
  }
  function schedule() { if (!scheduled && !stopped) { scheduled = true; queueMicrotask(() => { scheduled = false; try { sync(); } catch (error) { console.error('[Cの炼金工坊] 分组执行同步失败', error); } }); } }
  const c = context(), events = [...new Set(['CHAT_CHANGED', 'OAI_PRESET_CHANGED_AFTER', 'PRESET_CHANGED', 'MAIN_API_CHANGED', 'SETTINGS_UPDATED', 'CHARACTER_EDITED'].map(k => c?.eventTypes?.[k]).filter(Boolean))];
  for (const event of events) c.eventSource.on(event, schedule);
  document.addEventListener('prw:resources-saved', schedule);
  document.addEventListener('prw:runtime-sync', schedule);
  const preference = () => { enabled = groupingEnabled(); schedule(); };
  document.addEventListener('prw:grouping-preference', preference);
  void Promise.all([
    loadModule('/scripts/extensions/regex/engine.js'),
    loadModule('/scripts/openai.js'),
  ]).then(([rx, oa]) => { engine = rx; openai = oa; schedule(); }).catch(error => console.error('[Cの炼金工坊] 分组执行接口未加载', error));
  return () => {
    stopped = true;
    for (const restore of bindings.values()) restore(); bindings.clear();
    const p = promptPatch;
    if (p && p.manager.getPromptCollection === p.get) p.manager.getPromptCollection = p.originalGet;
    if (p && p.manager.isPromptDisabledForActiveCharacter === p.disabled) p.manager.isPromptDisabledForActiveCharacter = p.originalDisabled;
    if (p && p.manager.preparePrompt === p.prepare && p.originalPrepare) p.manager.preparePrompt = p.originalPrepare;
    for (const event of events) c.eventSource.removeListener(event, schedule);
    document.removeEventListener('prw:resources-saved', schedule);
    document.removeEventListener('prw:runtime-sync', schedule);
    document.removeEventListener('prw:grouping-preference', preference);
  };
}
