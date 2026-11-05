interface DragCallbacks {
  start(row: HTMLElement): string | undefined;
  over(element: HTMLElement | null, y: number): void;
  drop(): void;
  end(): void;
}

// Delay activation so a click compares, while a quick touch swipe still scrolls.
export function installEntryDrag(root: () => HTMLElement | undefined, callbacks: DragCallbacks) {
  const abort = new AbortController(), signal = abort.signal;
  let press: { row: HTMLElement; pointer: number; x: number; y: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, frame = 0, active = false;
  let preview: HTMLElement | undefined, x = 0, y = 0, suppressUntil = 0;
  function cancel() {
    clearTimeout(timer); cancelAnimationFrame(frame); frame = 0;
    const old = press; press = undefined;
    if (active) suppressUntil = performance.now() + 350;
    active = false;
    old?.row.classList.remove('entry-dragging');
    if (old?.row.hasPointerCapture(old.pointer)) old.row.releasePointerCapture(old.pointer);
    preview?.remove(); preview = undefined; callbacks.end();
  }
  function hit() {
    const element = document.elementFromPoint(x, y) as HTMLElement | null;
    return element && root()?.contains(element) ? element : null;
  }
  function update() {
    frame = 0;
    if (!active) return;
    if (!press?.row.isConnected) { cancel(); return; }
    const element = hit(), list = element?.closest<HTMLElement>('.entry-list');
    callbacks.over(element, y);
    if (preview) {
      preview.style.left = `${Math.max(4, Math.min(x + 14, innerWidth - preview.offsetWidth - 4))}px`;
      preview.style.top = `${Math.max(4, Math.min(y + 14, innerHeight - preview.offsetHeight - 4))}px`;
    }
    if (list) {
      const bounds = list.getBoundingClientRect();
      const delta = y < bounds.top + 40 ? -12 : y > bounds.bottom - 40 ? 12 : 0;
      const before = list.scrollTop;
      if (delta) list.scrollTop += delta;
      if (before !== list.scrollTop) frame = requestAnimationFrame(update);
    }
  }
  document.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.isPrimary) return;
    suppressUntil = 0;
    const el = e.target as HTMLElement, row = el.closest<HTMLElement>('.entry.can-drag');
    if (!row || !root()?.contains(row) || el.closest('button,input,label,select,textarea,summary,details,a')) return;
    cancel();
    press = { row, pointer: e.pointerId, x: e.clientX, y: e.clientY }; x = e.clientX; y = e.clientY;
    timer = setTimeout(() => {
      if (!press || !row.isConnected) { cancel(); return; }
      const label = callbacks.start(row);
      if (!label) { cancel(); return; }
      active = true; row.classList.add('entry-dragging'); row.setPointerCapture(press.pointer);
      preview = document.createElement('div'); preview.className = 'prw-entry-drag-preview'; preview.textContent = label;
      root()?.append(preview); update();
    }, 300);
  }, { signal, capture: true });
  document.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.pointer) return;
    x = e.clientX; y = e.clientY;
    if (!active) { if (Math.hypot(x - press.x, y - press.y) > 8) cancel(); return; }
    e.preventDefault(); e.stopImmediatePropagation();
    if (!frame) frame = requestAnimationFrame(update);
  }, { signal, capture: true, passive: false });
  document.addEventListener('touchmove', e => { if (active) e.preventDefault(); }, { signal, capture: true, passive: false });
  document.addEventListener('pointerup', e => {
    if (!press || e.pointerId !== press.pointer) return;
    if (active) {
      e.preventDefault(); e.stopImmediatePropagation();
      x = e.clientX; y = e.clientY; cancelAnimationFrame(frame); update();
      try { if (active && press && Math.hypot(x - press.x, y - press.y) > 8) callbacks.drop(); } finally { cancel(); }
    } else cancel();
  }, { signal, capture: true });
  document.addEventListener('pointercancel', cancel, { signal, capture: true });
  document.addEventListener('lostpointercapture', e => { if (press?.pointer === e.pointerId) cancel(); }, { signal, capture: true });
  document.addEventListener('keydown', e => {
    if (press && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(); }
  }, { signal, capture: true });
  document.addEventListener('click', e => {
    if (root()?.contains(e.target as Node) && performance.now() < suppressUntil) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, { signal, capture: true });
  document.addEventListener('contextmenu', e => { if (press) e.preventDefault(); }, { signal, capture: true });
  window.addEventListener('blur', cancel, { signal });
  return { cancel, destroy() { cancel(); abort.abort(); } };
}
