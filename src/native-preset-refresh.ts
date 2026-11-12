import { readPreferences } from './preferences';
import { nativeDragBusy } from './native-drag';
import { prepareNativePreset, publishNativePreset } from './native-preset-paint';

let transition = false;
export const presetTransitionBusy = () => transition;
export function assertPresetReady() {
  if (transition) throw new Error('预设仍在切换，请等条目更新后再操作');
}
type Loader = (path: string) => Promise<any>;
const SELECT = '#settings_preset_openai';
const PROTECTED = '#update_oai_preset,#new_oai_preset,#save_oai_preset,#delete_oai_preset,#rename_oai_preset,#export_oai_preset,[data-preset-manager-rename="openai"],' +
  '#completion_prompt_manager,#completion_prompt_manager_popup,#quick-edit-container';

/** Optional native UI optimization. Never writes prompt data or replaces native save/sort handlers. */
export function installNativePresetRefresh(load: Loader = p => import(/* webpackIgnore: true */ new URL(p, location.href).href)) {
  const context = window.SillyTavern?.getContext?.(), events = context?.eventTypes;
  const abort = new AbortController(), signal = abort.signal;
  let options = readPreferences(), stopped = false, manager: any, script: any, groups: any, utils: any;
  let binding: { render: any; debounced: any; wrapped: any; deferred: any; renderOwn: boolean } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, tokenTimer: ReturnType<typeof setTimeout> | undefined;
  let epoch = 0, requested = false, painting = false, counting = false, countNeeded = false, tokensPending = false;
  let tokensFailed = false;
  let applying = false, latest: { name: string; preset: any } | undefined, failed = false;
  const applications = new Set<any>();
  const protectedNodes = new Map<HTMLElement, { inert: boolean; aria: string | null }>();
  let notice: HTMLElement | undefined;
  const selected = () => context?.getPresetManager('openai')?.getSelectedPresetName();
  const active = () => options.presetRefresh || options.presetSwitch || transition;
  const usable = () => manager && script?.main_api === 'openai' &&
    (manager.configuration.promptOrder.strategy !== 'character' || manager.activeCharacter);
  function protect() {
    if (!transition) return;
    for (const node of document.querySelectorAll<HTMLElement>(PROTECTED)) {
      if (!protectedNodes.has(node)) protectedNodes.set(node, { inert: node.inert, aria: node.getAttribute('aria-disabled') });
      node.inert = true; node.setAttribute('aria-disabled', 'true');
    }
    manager?.containerElement?.classList.add('prw-preset-pending');
    if (!notice) {
      notice = document.createElement('div'); notice.className = 'prw-preset-status'; notice.setAttribute('role', 'status');
      document.querySelector(SELECT)?.closest('#openai_api-presets')?.after(notice);
    }
    notice.textContent = failed ? '切换未完成，请重新选择预设。保存仍受保护。' : '正在切换预设…';
  }
  function release() {
    transition = false;
    for (const [node, before] of protectedNodes) {
      node.inert = before.inert;
      if (before.aria === null) node.removeAttribute('aria-disabled'); else node.setAttribute('aria-disabled', before.aria);
      node.classList.remove('prw-preset-pending');
    }
    protectedNodes.clear(); notice?.remove(); notice = undefined;
  }
  function error(value: unknown) {
    failed = true; protect();
    console.warn('[Cの炼金工坊] 原生预设刷新未完成', value);
  }
  function schedule(delay = 0) {
    clearTimeout(timer);
    timer = setTimeout(() => { void paint(); }, delay);
  }
  function request(recount = true) {
    // A dry run can itself ask for render(false). That is a token update, not another edit.
    if (recount || !counting) epoch++;
    requested = true;
    if (recount) { countNeeded = true; tokensPending = true; tokensFailed = false; }
    else if (!counting) { tokensPending = tokensFailed = countNeeded = false; }
    schedule();
  }
  function canPublish() {
    if (!applying) return true;
    return !applications.size && latest && selected() === latest.name && manager.serviceSettings.prompts === latest.preset.prompts;
  }
  async function paint() {
    if (stopped || !requested || painting || !usable() || !active() || failed) return;
    if (nativeDragBusy() || !canPublish()) { schedule(80); return; }
    painting = true; requested = false;
    const revision = epoch, name = selected(), prompts = manager.serviceSettings.prompts;
    try {
      const stage = await prepareNativePreset(manager, tokensFailed ? 'failed' : tokensPending, options.presetRefresh);
      if (stopped || !active() || revision !== epoch || name !== selected() || prompts !== manager.serviceSettings.prompts) return;
      if (nativeDragBusy()) { requested = true; return; }
      // Switching also uses the staged native tree; ordinary optimized edits retain the existing rows.
      publishNativePreset(manager, stage, options.presetRefresh);
      if (applying) {
        applying = false; latest = undefined; applications.clear(); release();
        document.dispatchEvent(new Event('prw:preset-ready'));
      }
      if (!active()) {
        requested = countNeeded = tokensPending = false;
        restore(); binding = undefined;
        return;
      }
      scheduleCount();
    } catch (e) {
      if (stopped || !active() || revision !== epoch) return;
      if (transition) error(e);
      else {
        console.warn('[Cの炼金工坊] 当前原生界面不支持局部刷新，使用原生刷新', e);
        applying = false; latest = undefined; applications.clear();
        requested = countNeeded = tokensPending = tokensFailed = false;
        clearTimeout(tokenTimer);
        restore(); binding = undefined;
        // Capability fallback, without a client-version gate.
        manager.render();
      }
    } finally {
      painting = false;
      if (requested && !failed) schedule(40);
    }
  }
  function scheduleCount() {
    clearTimeout(tokenTimer);
    if (!countNeeded || counting || stopped) return;
    tokenTimer = setTimeout(() => { void count(); }, 180);
  }
  async function count() {
    if (stopped || !active() || !countNeeded || counting || applying || failed) return;
    if (nativeDragBusy() || script.is_send_press || groups?.is_group_generating) { scheduleCount(); return; }
    counting = true; countNeeded = false;
    const revision = epoch, name = selected();
    try {
      await manager.tryGenerate();
      if (!stopped && active() && revision === epoch && name === selected()) {
        tokensPending = tokensFailed = false; requested = true; schedule();
      }
    } catch (e) {
      // Keep the new list usable. Never present counts from an old preset as current.
      console.warn('[Cの炼金工坊] Token统计失败，条目仍可操作', e);
      if (!stopped && active() && revision === epoch && name === selected()) {
        tokensFailed = true; requested = true; schedule();
      }
    } finally { counting = false; scheduleCount(); }
  }
  function restore() {
    if (!binding) return;
    if (manager.render === binding.wrapped) {
      if (binding.renderOwn) manager.render = binding.render; else delete manager.render;
    }
    if (manager.renderDebounced === binding.deferred) manager.renderDebounced = binding.debounced;
  }
  function bind() {
    if (!manager || binding || !active()) return;
    const methods = ['render', 'renderDebounced', 'renderPromptManager', 'renderPromptManagerListItems', 'makeDraggable', 'tryGenerate'];
    if (methods.some(k => typeof manager[k] !== 'function')) {
      console.warn('[Cの炼金工坊] 当前酒馆缺少原生刷新接口'); return;
    }
    // A third-party bound/arrow renderer could ignore the detached receiver and clear live DOM.
    const prototype = Object.getPrototypeOf(manager);
    if (['renderPromptManager', 'renderPromptManagerListItems'].some(k => manager[k] !== prototype?.[k])) {
      console.warn('[Cの炼金工坊] 原生模板渲染已被其他扩展接管，保留现有刷新'); return;
    }
    const render = manager.render, debounced = manager.renderDebounced, renderOwn = Object.hasOwn(manager, 'render');
    utils?.cancelDebounce?.(debounced);
    const wrapped = function (this: any, afterTryGenerate = true) {
      if (stopped || (!options.presetRefresh && !applying && !tokensPending)) return render.call(this, afterTryGenerate);
      request(afterTryGenerate !== false);
    };
    const deferred = function (this: any, ...args: any[]) {
      if (stopped || (!options.presetRefresh && !applying && !tokensPending)) return debounced.apply(this, args);
      request(args[0] !== false);
    };
    binding = { render, debounced, wrapped, deferred, renderOwn };
    manager.render = wrapped; manager.renderDebounced = deferred;
  }
  function begin(event: any) {
    if (!active() || !binding) return;
    if (failed) applications.clear();
    latest = { name: event.presetName, preset: event.preset };
    applications.add(event.preset); applying = true; failed = false;
    epoch++; requested = false; countNeeded = true; tokensPending = true; tokensFailed = false;
    if (options.presetSwitch) transition = true;
    protect(); document.dispatchEvent(new Event('prw:preset-changing'));
    // The native promise is assigned after BEFORE emit starts. Read it on the next microtask.
    queueMicrotask(() => {
      const promise = openai?.getPresetApplicationPromise?.();
      if (promise) void promise.catch((e: unknown) => { if (!stopped && applications.has(event.preset)) error(e); });
    });
  }
  function applied() {
    if (!applying || !manager) return;
    for (const preset of applications) if (manager.serviceSettings.prompts === preset.prompts) applications.delete(preset);
    if (!applications.size && !canPublish()) {
      error(new Error('连续切换的应用顺序不一致')); return;
    }
    request();
  }
  const apiChanged = () => { if (requested) schedule(); };
  // Native pointer and keyboard activation is stopped before any native save/edit handler runs.
  const block = (event: Event) => {
    if (active() && tokensPending && ['click', 'keydown'].includes(event.type) && event.target instanceof Element &&
      event.target.closest('#completion_prompt_manager .prompt-manager-inspect-action')) {
      // The native inspector reads the last dry-run messages, which can still belong to the previous preset.
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (!transition || !(event.target instanceof Element) || !event.target.closest(PROTECTED)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  for (const type of ['click', 'mousedown', 'touchstart', 'keydown', 'change', 'input'])
    window.addEventListener(type, block, { signal, capture: true, passive: false });
  // Capture a real select change before the native handler changes the displayed name.
  document.addEventListener('change', event => {
    if (!options.presetSwitch || !binding || !(event.target instanceof Element) || !event.target.matches(SELECT)) return;
    transition = true; protect();
  }, { signal, capture: true });
  const preference = () => {
    options = readPreferences();
    if (!active()) {
      epoch++; requested = countNeeded = tokensPending = false; clearTimeout(timer); clearTimeout(tokenTimer);
      restore(); binding = undefined;
    } else bind();
  };
  document.addEventListener('prw:preset-performance-preference', preference, { signal });
  document.addEventListener('prw:native-drag-end', () => { if (requested) schedule(); scheduleCount(); }, { signal });
  let openai: any;
  void Promise.all([load('/scripts/openai.js'), load('/script.js'), load('/scripts/group-chats.js'), load('/scripts/utils.js')])
    .then(([oa, s, g, u]) => {
      if (stopped) return;
      openai = oa; manager = oa.promptManager; script = s; groups = g; utils = u;
      bind();
      if (events?.OAI_PRESET_CHANGED_BEFORE) {
        context.eventSource.on(events.OAI_PRESET_CHANGED_BEFORE, begin);
        context.eventSource.makeFirst?.(events.OAI_PRESET_CHANGED_BEFORE, begin);
      }
      if (events?.OAI_PRESET_CHANGED_AFTER) context.eventSource.on(events.OAI_PRESET_CHANGED_AFTER, applied);
      if (events?.MAIN_API_CHANGED) context.eventSource.on(events.MAIN_API_CHANGED, apiChanged);
    }).catch(e => console.warn('[Cの炼金工坊] 原生预设优化接口未加载', e));
  return () => {
    stopped = true; epoch++; clearTimeout(timer); clearTimeout(tokenTimer); abort.abort(); restore(); release();
    if (events?.OAI_PRESET_CHANGED_BEFORE) context.eventSource.removeListener(events.OAI_PRESET_CHANGED_BEFORE, begin);
    if (events?.OAI_PRESET_CHANGED_AFTER) context.eventSource.removeListener(events.OAI_PRESET_CHANGED_AFTER, applied);
    if (events?.MAIN_API_CHANGED) context.eventSource.removeListener(events.MAIN_API_CHANGED, apiChanged);
  };
}
