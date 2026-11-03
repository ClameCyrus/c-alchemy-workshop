import { holdNativeDrag } from './native-drag';
import type { Resource } from './types';

const ROOT = '#completion_prompt_manager_list', ROW = '.completion_prompt_manager_prompt[data-pm-identifier]';
const CONTROL = '.prompt_manager_prompt_controls,button,input,select,textarea,[contenteditable=true],.menu_button';
interface Target { element: HTMLElement; groupId: string; after: boolean; header?: boolean }
interface Session {
  root: HTMLElement; row: HTMLElement; ref: Resource; id: string; groupId: string;
  instance: any; placeholder: HTMLElement; target?: Target; release: () => void; canceled: boolean; saving: boolean;
}
/** Keep Tavern's Sortable instance, gesture, items selector and native update callback intact. */
export function installNativePresetDrag(
  resource: (row: HTMLElement) => Resource | undefined,
  guard: (ref: Resource) => void,
  move: (ref: Resource, id: string, groupId: string, order: string[]) => Promise<void>,
  fail: (error: unknown) => void,
) {
  const jq = (window as any).jQuery;
  if (!jq?.fn?.sortable) return () => {};
  const abort = new AbortController(), signal = abort.signal, namespace = '.prwNativePreset';
  let session: Session | undefined, line: HTMLElement | undefined, stopped = false;
  let frame = 0, x = 0, y = 0;
  function finish(changed = false) {
    if (!session) return;
    cancelAnimationFrame(frame); frame = 0;
    const current = session; session = undefined; line?.remove(); line = undefined;
    // Sortable.cancel() restores its original DOM position after stop; keep observers paused until then.
    queueMicrotask(() => {
      current.release(); document.dispatchEvent(new CustomEvent('prw:native-drag-end', { detail: { changed } }));
    });
  }
  function cancel() {
    if (!session || session.saving) return;
    const current = session, inst = current.instance, update = inst.options.update;
    current.canceled = true;
    // jQuery UI cancel() can emit update before putting the row back. Do not persist that transient order.
    const ignore = () => {}; inst.options.update = ignore;
    try { inst.cancel(); }
    finally { if (inst.options.update === ignore) inst.options.update = update; finish(); }
  }
  function targetAt(x: number, y: number): Target | undefined {
    if (!session) return;
    const { root, row, placeholder } = session;
    const hits = document.elementsFromPoint(x, y).filter(e => e !== row && !row.contains(e) && !e.closest('.prw-native-drop-line'));
    for (const hit of hits) {
      if (hit === placeholder || placeholder.contains(hit)) return session.target;
      const element = hit.closest<HTMLElement>(`${ROW},.prw-native-group-header`);
      if (!element || element === row || !root.contains(element)) continue;
      const header = element.classList.contains('prw-native-group-header'), r = element.getBoundingClientRect();
      return { element, header, groupId: (header ? element.dataset.groupId : element.dataset.prwGroupId) || '', after: y >= r.top + r.height / 2 };
    }
    if (hits.includes(root)) {
      const last = [...root.querySelectorAll<HTMLElement>(`${ROW},.prw-native-group-header`)].reverse().find(e => e !== row && e !== placeholder && e.getBoundingClientRect().height > 0);
      if (last && y >= last.getBoundingClientRect().bottom) return { element: root, groupId: '', after: true };
      return session.target;
    }
  }
  function place(target: Target) {
    if (!session) return;
    const { root, row, placeholder } = session;
    if (target.element === placeholder) return;
    if (target.header) {
      const last = [...root.querySelectorAll<HTMLElement>(ROW)].filter(e => e !== row && e.dataset.prwGroupId === target.groupId).at(-1) || target.element;
      if (last.nextElementSibling !== placeholder) last.after(placeholder);
    } else if (target.element === root) {
      if (root.lastElementChild !== placeholder) root.append(placeholder);
    } else if (target.after) {
      if (target.element.nextElementSibling !== placeholder) target.element.after(placeholder);
    } else if (target.element.previousElementSibling !== placeholder) target.element.before(placeholder);
  }
  function mark(x: number, y: number, captured = false) {
    if (!session || session.saving || session.canceled) return;
    const target = captured ? session.target : targetAt(x, y); session.target = target;
    if (!target) { if (line) line.style.display = 'none'; return; }
    place(target);
    if (!line) { line = document.createElement('div'); line.className = 'prw-native-drop-line'; document.body.append(line); }
    const r = target.element.getBoundingClientRect();
    line.style.cssText = `display:block;left:${r.left}px;width:${r.width}px;top:${target.header ? r.bottom : target.after ? r.bottom : r.top}px`;
  }
  // Preflight never changes pointer handling for native controls, or replaces the drag gesture.
  window.addEventListener('mousedown', e => {
    const el = e.target as Element, row = el?.closest<HTMLElement>(ROW), root = row?.closest<HTMLElement>(ROOT);
    if (e.button !== 0 || !root?.classList.contains('prw-native-grouped') || el.closest(CONTROL)) return;
    const instance = jq(root).data('ui-sortable');
    if (!instance || instance.options.disabled || (instance.options.handle && !jq(el).closest(instance.options.handle, root).length)) return;
    try {
      if (session?.saving) throw new Error('分组保存中，请稍候');
      const ref = resource(row!); if (ref) guard(ref);
    } catch (error) { e.preventDefault(); e.stopImmediatePropagation(); fail(error); }
  }, { signal, capture: true });
  jq(document).on(`sortstart${namespace}`, ROOT, (e: any, ui: any) => {
    const root = e.currentTarget as HTMLElement, row = ui.item?.[0] as HTMLElement;
    if (!root.classList.contains('prw-native-grouped') || !row?.matches(ROW)) return;
    const ref = resource(row), instance = jq(root).data('ui-sortable'); if (!ref || !instance) return;
    session = { root, row, ref, instance, id: row.dataset.pmIdentifier!, groupId: row.dataset.prwGroupId || '',
      placeholder: ui.placeholder[0], release: holdNativeDrag(), canceled: false, saving: false };
    session.target = { element: session.placeholder, groupId: session.groupId, after: false };
    document.dispatchEvent(new Event('prw:native-drag-start'));
  });
  jq(document).on(`sort${namespace}`, ROOT, (e: any) => {
    if (!session || e.currentTarget !== session.root || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
    x = e.clientX; y = e.clientY;
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; mark(x, y, true); });
  });
  // Record the hovered row before Sortable replaces its place with the placeholder.
  window.addEventListener('mousemove', e => {
    if (session && !session.saving && !session.canceled) session.target = targetAt(e.clientX, e.clientY);
  }, { signal, capture: true, passive: true });
  window.addEventListener('mouseup', e => {
    if (!session || session.saving) return;
    cancelAnimationFrame(frame); frame = 0;
    mark(e.clientX, e.clientY);
    if (!session.target) { e.stopImmediatePropagation(); cancel(); }
  }, { signal, capture: true });
  jq(document).on(`sortstop${namespace}`, ROOT, (e: any) => {
    const current = session; if (!current || e.currentTarget !== current.root) return;
    line?.remove(); line = undefined;
    if (current.canceled || !current.target || current.target.groupId === current.groupId) { finish(); return; }
    current.saving = true;
    // The native update callback runs synchronously before stop. Commit after all native stop handlers finish.
    queueMicrotask(() => {
      if (stopped || session !== current) return;
      const order = [...current.root.querySelectorAll<HTMLElement>(ROW)].map(row => row.dataset.pmIdentifier!);
      void move(current.ref, current.id, current.target!.groupId, order).then(() => finish(true), error => {
        finish(); fail(new Error(`分组归属保存失败，原生排序可能已改变。${error instanceof Error ? error.message : String(error)}`));
      });
    });
  });
  window.addEventListener('keydown', e => { if (session && !session.saving && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } }, { signal, capture: true });
  window.addEventListener('blur', cancel, { signal });
  document.addEventListener('prw:grouping-preference', cancel, { signal });
  return () => { stopped = true; cancel(); finish(); abort.abort(); jq(document).off(namespace); };
}
