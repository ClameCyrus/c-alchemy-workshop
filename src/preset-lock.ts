import { readPreferences } from './preferences';
import { nativeDragBusy } from './native-drag';

const KEY = 'c-alchemy-workshop:preset-lock:v1';
const ROW = '.completion_prompt_manager_prompt[data-pm-identifier]';
const INTERACTIVE = '.prompt_manager_prompt_controls,a,button,input,select,textarea,[contenteditable="true"],[data-preset-prompt-action],.prw-row-more,.prw-preset-lock';
const DRAG = 'completion_prompt_manager_prompt_draggable';
export function installPresetLock() {
  const abort = new AbortController(), signal = abort.signal;
  let enabled = readPreferences().presetLock;
  let locked = false;
  try { locked = (localStorage.getItem(KEY) ?? localStorage.getItem('preset_drag_lock_v1')) === 'true'; } catch {}
  const rows = new Map<HTMLElement, { draggable: string | null; custom: boolean }>();
  const sortables = new Map<HTMLElement, { instance: any; disabled: boolean }>();
  let button: HTMLButtonElement | undefined, queued = false, stopped = false;
  function restore() {
    for (const [row, before] of rows) {
      if (before.custom) row.classList.add(DRAG);
      if (before.draggable === null) row.removeAttribute('draggable'); else row.setAttribute('draggable', before.draggable);
    }
    rows.clear();
    for (const [root, before] of sortables) {
      const current = (window as any).jQuery?.(root).data('ui-sortable');
      if (current === before.instance) current.option('disabled', before.disabled);
    }
    sortables.clear();
    document.querySelectorAll('.prw-preset-locked').forEach(e => e.classList.remove('prw-preset-locked'));
  }
  function scan() {
    queued = false; if (stopped) return;
    if (!enabled) { button?.remove(); button = undefined; restore(); return; }
    if (nativeDragBusy()) return;
    const root = document.querySelector<HTMLElement>('#completion_prompt_manager_list');
    const header = document.querySelector('.completion_prompt_manager_header_advanced') || root?.parentElement?.querySelector('.completion_prompt_manager_header');
    if (!button && header) {
      button = document.createElement('button'); button.type = 'button'; button.className = 'prw-preset-lock menu_button';
      button.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); locked = !locked; try { localStorage.setItem(KEY, String(locked)); } catch {} scan(); });
    }
    if (button && header && button.parentElement !== header) header.append(button);
    if (button) {
      button.title = locked ? '已锁定排序，点击解锁' : '锁定排序'; button.setAttribute('aria-label', locked ? '解锁预设排序' : '锁定预设排序');
      button.setAttribute('aria-pressed', String(locked));
      const glyph = locked ? 'fa-lock' : 'fa-unlock';
      if (button.dataset.icon !== glyph) { button.innerHTML = `<i class="fa-solid ${glyph}" aria-hidden="true"></i>`; button.dataset.icon = glyph; }
    }
    if (!locked || !root) { restore(); return; }
    for (const [oldRoot, before] of sortables) if (oldRoot !== root) {
      const current = (window as any).jQuery?.(oldRoot).data('ui-sortable');
      if (current === before.instance) current.option('disabled', before.disabled);
      oldRoot.classList.remove('prw-preset-locked'); sortables.delete(oldRoot);
    }
    // Never detach the jQuery instance: other preset tools must still be able to find it.
    const instance = (window as any).jQuery?.(root).data('ui-sortable');
    if (instance) {
      if (sortables.get(root)?.instance !== instance) sortables.set(root, { instance, disabled: !!instance.option('disabled') });
      if (!instance.option('disabled')) instance.option('disabled', true);
    }
    root.classList.add('prw-preset-locked');
    for (const row of root.querySelectorAll<HTMLElement>(ROW)) {
      if (!rows.has(row)) rows.set(row, { draggable: row.getAttribute('draggable'), custom: row.classList.contains(DRAG) });
      row.classList.remove(DRAG); if (row.getAttribute('draggable') !== 'false') row.setAttribute('draggable', 'false');
    }
    for (const [row, before] of rows) if (!root.contains(row)) {
      if (before.custom) row.classList.add(DRAG);
      if (before.draggable === null) row.removeAttribute('draggable'); else row.setAttribute('draggable', before.draggable);
      rows.delete(row);
    }
  }
  function gate(event: Event) {
    if (!enabled || !locked) return;
    const target = event.target as Element;
    if (!target?.closest?.('#completion_prompt_manager_list') || !target.closest(ROW) || target.closest(INTERACTIVE)) return;
    if (event.type === 'dragstart') event.preventDefault();
    event.stopImmediatePropagation();
  }
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dragstart']) window.addEventListener(type, gate, { signal, capture: true, passive: false });
  const schedule = () => { if (!queued && enabled) { queued = true; queueMicrotask(scan); } };
  const observer = new MutationObserver(records => { if (records.some(r => [...r.addedNodes, ...r.removedNodes].some(n => n instanceof Element && !n.closest('.prw-preset-lock')))) schedule(); });
  const observe = () => { observer.disconnect(); const root = document.querySelector('#openai_settings'); if (enabled && root) observer.observe(root, { childList: true, subtree: true }); };
  document.addEventListener('prw:lock-preference', () => { enabled = readPreferences().presetLock; observe(); scan(); }, { signal });
  document.addEventListener('prw:resources-saved', schedule, { signal });
  document.addEventListener('prw:native-drag-end', schedule, { signal });
  observe(); scan();
  return () => { stopped = true; abort.abort(); observer.disconnect(); button?.remove(); restore(); };
}
