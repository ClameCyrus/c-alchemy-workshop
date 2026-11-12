import { installEntryDrag } from './entry-drag';
import { holdNativeDrag, nativeDragBusy } from './native-drag';
import { presetTransitionBusy } from './native-preset-refresh';
import type { Resource } from './types';

const ROW = '[data-pm-identifier],.regex-script-label';
export function installNativeGroupDrag(resource: (row: HTMLElement) => Resource | undefined,
  guard: (ref: Resource) => void,
  move: (ref: Resource, id: string, target?: string, after?: boolean) => Promise<void>, fail: (error: unknown) => void) {
  let source: { root: HTMLElement; ref: Resource; id: string } | undefined;
  let target: { id?: string; after: boolean } | undefined, line: HTMLElement | undefined;
  let release: (() => void) | undefined, saving = false;
  const finish = (changed = false) => {
    line?.remove(); line = undefined; source = undefined; target = undefined;
    const held = release; release = undefined; held?.();
    if (held) document.dispatchEvent(new CustomEvent('prw:native-drag-end', { detail: { changed } }));
  };
  const drag = installEntryDrag(() => document.body, {
    start(header) {
      const root = header.closest<HTMLElement>('.prw-native-grouped'), id = header.dataset.groupId;
      if (!root || !id || saving || nativeDragBusy() || root.classList.contains('prw-preset-locked') ||
        (root.id === 'completion_prompt_manager_list' && (presetTransitionBusy() || (window as any).jQuery?.(root).data('ui-sortable')?.options.disabled))) return;
      const row = [...root.querySelectorAll<HTMLElement>(ROW)].find(r => r.dataset.prwGroupId === id);
      const ref = row && resource(row); if (!ref) return;
      try { guard(ref); } catch (error) { fail(error); return; }
      source = { root, id, ref }; release = holdNativeDrag();
      document.dispatchEvent(new Event('prw:native-drag-start'));
      line = document.createElement('div'); line.className = 'prw-native-drop-line'; document.body.append(line);
      return header.querySelector('.prw-group-title')?.textContent || '移动分组';
    },
    over(element, y) {
      target = undefined; if (line) line.style.display = 'none';
      if (!source || !element || !source.root.contains(element)) return;
      const hit = element.closest<HTMLElement>(`${ROW},.prw-native-group-header`);
      if (!hit) return;
      const groupId = hit.classList.contains('prw-native-group-header') ? hit.dataset.groupId : hit.dataset.prwGroupId;
      if (groupId === source.id) return;
      const after = y >= hit.getBoundingClientRect().top + hit.getBoundingClientRect().height / 2;
      const members = groupId ? [...source.root.querySelectorAll<HTMLElement>(ROW)].filter(r => r.dataset.prwGroupId === groupId) : [hit];
      const anchor = after ? members.at(-1) : members[0]; if (!anchor) return;
      target = { id: anchor.dataset.pmIdentifier || anchor.dataset.regexScriptId || anchor.id, after };
      const visible = groupId ? [...source.root.querySelectorAll<HTMLElement>('.prw-native-group-header')].filter(h => h.dataset.groupId === groupId) : [];
      const edge = after ? [...members, ...visible].filter(e => e.getBoundingClientRect().height).sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] : visible[0] || anchor;
      const bounds = (edge || hit).getBoundingClientRect();
      if (line) line.style.cssText = `display:block;left:${bounds.left}px;width:${bounds.width}px;top:${after ? bounds.bottom : bounds.top}px`;
    },
    drop() {
      if (!source || !target) return;
      const current = source, position = target; saving = true; line?.remove();
      void move(current.ref, current.id, position.id, position.after).then(() => finish(true), error => { finish(); fail(error); }).finally(() => { saving = false; });
    },
    end() { if (!saving) finish(); },
  }, { selector: '.prw-native-group-header', handle: '.prw-group-drag', scrollSelector: '.prw-native-grouped' });
  return () => { drag.destroy(); finish(); };
}
