import type { Resource } from './types';

let active = false;
const holds = new Set<object>();
export function holdNativeDrag() {
  const token = {}; holds.add(token);
  return () => { holds.delete(token); };
}
export function nativeDragBusy() {
  return active || holds.size > 0 || !!document.querySelector('.regex-script-label.ui-sortable-helper,.regex-script-label.sortable-drag,#completion_prompt_manager_list .ui-sortable-helper');
}
interface Position { id?: string; after: boolean; groupId: string; element: HTMLElement }
export function installNativeRegexDrag(
  resource: (row: HTMLElement) => Resource | undefined,
  move: (ref: Resource, id: string, position: Position) => Promise<void>,
  fail: (error: unknown) => void,
) {
  const abort = new AbortController(), signal = abort.signal;
  let session: { row: HTMLElement; root: HTMLElement; ref: Resource; id: string; pointer: number; x: number; y: number; started: boolean } | undefined;
  let target: Position | undefined, preview: HTMLElement | undefined, line: HTMLElement | undefined;
  let frame = 0, x = 0, y = 0, blockedClickUntil = 0, saving = false, stopped = false;
  function release(changed = false) {
    const started = session?.started;
    cancelAnimationFrame(frame); frame = 0;
    if (session?.started && !saving) blockedClickUntil = performance.now() + 300;
    session?.row.classList.remove('prw-native-moving');
    if (session?.row.hasPointerCapture?.(session.pointer)) session.row.releasePointerCapture(session.pointer);
    session = undefined; target = undefined; preview?.remove(); line?.remove(); preview = line = undefined;
    active = false;
    if (started) document.dispatchEvent(new CustomEvent('prw:native-drag-end', { detail: { changed } }));
  }
  function scrollParent(node: HTMLElement) {
    for (let el: HTMLElement | null = node; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
    }
    return document.scrollingElement as HTMLElement;
  }
  function update() {
    frame = 0;
    if (!session?.started || saving) return;
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const candidate = hit?.closest<HTMLElement>('.regex-script-label,.prw-native-group-header');
    target = undefined;
    if (candidate && session.root.contains(candidate)) {
      const r = candidate.getBoundingClientRect(), header = candidate.classList.contains('prw-native-group-header');
      target = { element: candidate, id: header ? undefined : candidate.dataset.regexScriptId || candidate.id,
        after: !header && y >= r.top + r.height / 2, groupId: header ? candidate.dataset.groupId || '' : candidate.dataset.prwGroupId || '' };
      if (line) {
        line.style.display = 'block'; line.style.left = `${r.left}px`; line.style.width = `${r.width}px`;
        line.style.top = `${header ? r.bottom - 2 : target.after ? r.bottom : r.top}px`;
      }
    } else if (hit && session.root.contains(hit)) {
      const r = session.root.getBoundingClientRect();
      target = { after: false, groupId: '', element: session.root };
      if (line) { line.style.display = 'block'; line.style.left = `${r.left}px`; line.style.width = `${r.width}px`; line.style.top = `${Math.min(r.bottom, innerHeight - 8)}px`; }
    } else if (line) line.style.display = 'none';
    if (preview) { preview.style.left = `${Math.max(4, Math.min(x + 14, innerWidth - preview.offsetWidth - 4))}px`; preview.style.top = `${Math.max(4, Math.min(y + 14, innerHeight - 40))}px`; }
    if (hit && session.root.contains(hit)) {
      const parent = scrollParent(session.root), r = parent === document.scrollingElement ? { top: 0, bottom: innerHeight } : parent.getBoundingClientRect();
      const step = y < r.top + 40 ? -10 : y > r.bottom - 40 ? 10 : 0;
      if (step) { const before = parent.scrollTop; parent.scrollTop += step; if (before !== parent.scrollTop) frame = requestAnimationFrame(update); }
    }
  }
  function start() {
    if (!session) return;
    active = session.started = true;
    session.row.classList.add('prw-native-moving');
    preview = document.createElement('div'); preview.className = 'prw-native-drag-preview';
    preview.textContent = session.row.querySelector('.regex_script_name')?.textContent || '移动正则';
    line = document.createElement('div'); line.className = 'prw-native-drop-line';
    document.body.append(preview, line);
    document.dispatchEvent(new Event('prw:native-drag-start'));
  }
  document.addEventListener('pointerdown', e => {
    // A fresh press is intentional; only suppress the click synthesized by the drag itself.
    blockedClickUntil = 0;
    if (e.button !== 0 || !e.isPrimary) return;
    const el = e.target as HTMLElement, row = el.closest<HTMLElement>('.regex-script-label');
    const root = row?.closest<HTMLElement>('.prw-native-grouped');
    if (!row || !root || !root.closest('#regex_container') || el.closest('button,input,label,select,textarea,a,.menu_button,.prw-row-more')) return;
    if (e.pointerType !== 'mouse' && !el.closest('.drag-handle,.menu-handle,.bai-bai-regex-script-drag-handle')) return;
    if (saving) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    const ref = resource(row); if (!ref) return;
    e.preventDefault(); e.stopImmediatePropagation();
    session = { row, root, ref, id: row.dataset.regexScriptId || row.id, pointer: e.pointerId, x: e.clientX, y: e.clientY, started: false };
    row.setPointerCapture(e.pointerId); x = e.clientX; y = e.clientY;
  }, { signal, capture: true, passive: false });
  document.addEventListener('pointermove', e => {
    if (!session || e.pointerId !== session.pointer || saving) return;
    x = e.clientX; y = e.clientY;
    if (!session.started && Math.hypot(x - session.x, y - session.y) >= 6) start();
    if (!session.started) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!frame) frame = requestAnimationFrame(update);
  }, { signal, capture: true, passive: false });
  document.addEventListener('pointerup', e => {
    if (!session || e.pointerId !== session.pointer || saving) return;
    if (!session.started) { release(); return; }
    blockedClickUntil = performance.now() + 300;
    e.preventDefault(); e.stopImmediatePropagation();
    x = e.clientX; y = e.clientY; cancelAnimationFrame(frame); update();
    const current = session, position = target;
    if (!position || position.id === current.id) { release(); return; }
    saving = true; preview?.remove(); line?.remove();
    void move(current.ref, current.id, position).then(() => { if (!stopped) release(true); }, error => { if (!stopped) { release(); fail(error); } }).finally(() => { saving = false; });
  }, { signal, capture: true });
  document.addEventListener('pointercancel', () => { if (!saving) release(); }, { signal, capture: true });
  document.addEventListener('keydown', e => { if (session && e.key === 'Escape' && !saving) { e.preventDefault(); e.stopImmediatePropagation(); release(); } }, { signal, capture: true });
  document.addEventListener('click', e => { if (performance.now() < blockedClickUntil) { e.preventDefault(); e.stopImmediatePropagation(); } }, { signal, capture: true });
  window.addEventListener('blur', () => { if (!saving && session) release(); }, { signal });
  const preference = () => { if (!saving && session) release(); };
  document.addEventListener('prw:grouping-preference', preference, { signal });
  return () => { stopped = true; abort.abort(); release(); };
}
