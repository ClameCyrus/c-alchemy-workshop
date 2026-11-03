import type { Host, OpenRequest, Resource } from './types';
import { installNativeGroupViews } from './native-groups';
import { createQuickUI } from './quick-ui';
import type { QuickSource } from './quick-operations';
import { groupingEnabled } from './preferences';
import { QuickOperations } from './quick-operations';
import { installNativeRegexDrag, nativeDragBusy } from './native-drag';
import { installNativePresetDrag } from './native-preset-drag';

export function installNativeMenus(host: Host, open: (request: OpenRequest) => void, guard: (ref: Resource) => void = () => {}): () => void {
  let groups: ReturnType<typeof installNativeGroupViews> | undefined;
  const quick = createQuickUI(host, guard, refs => groups?.invalidate(refs));
  const abort = new AbortController(),
    signal = abort.signal;
  let menu: HTMLDivElement | undefined;
  function close() {
    menu?.remove();
    menu = undefined;
  }
  function editResource(ref: Resource, id: string) {
    const fallback = () => open({ kind: ref.kind, refKey: ref.key, entryId: id, action: 'edit' });
    if (!host.edit) { fallback(); return; }
    void host.edit(ref, id).then(handled => { if (handled === false) fallback(); }).catch(quick.fail);
  }
  const currentRef = (row: HTMLElement, kind: 'preset' | 'regex', resources = host.resources(kind)): Resource | undefined => {
    if (row.dataset.prwRefKey) return resources.find(r => r.key === row.dataset.prwRefKey && (!row.dataset.prwRefName || r.name === row.dataset.prwRefName));
    if (kind === 'preset') return resources.find(r => r.live) || (host.demo ? resources[0] : undefined);
    const type =
      row.dataset.regexType ||
      (row.closest('#saved_regex_scripts') ? 'global' : row.closest('#saved_scoped_scripts') ? 'scoped' : 'preset');
    if (type === 'global') return resources.find(r => r.scope === 'global');
    if (type === 'scoped' || type === 'character') return resources.find(r => r.scope === 'scoped');
    const name = window.SillyTavern?.getContext().getPresetManager('openai')?.getSelectedPresetName();
    return resources.find(r => r.scope === 'preset' && (r.name === name || host.demo));
  };
  function checkedSources() {
    const map = new Map<string, string[]>();
    const resources = host.resources('regex');
    for (const checkbox of document.querySelectorAll<HTMLInputElement>(
      '#regex_container .regex_bulk_checkbox:checked,#regex_container .prw-native-selection:checked',
    )) {
      const row = checkbox.closest<HTMLElement>('.regex-script-label,.prw-native-row');
      if (!row || row.closest('.prw-native-original')) continue;
      const resource = currentRef(row, 'regex', resources),
        id = row.dataset.regexScriptId || row.id;
      if (!resource || !id) continue;
      const ids = map.get(resource.key) || [];
      if (!ids.includes(id)) ids.push(id);
      map.set(resource.key, ids);
    }
    return [...map].map(([refKey, ids]) => ({ refKey, ids }));
  }
  function show(row: HTMLElement, trigger: HTMLElement, kind: 'preset' | 'regex') {
    close();
    const ref = currentRef(row, kind),
      id = row.dataset.pmIdentifier || row.dataset.regexScriptId || row.id;
    if (!ref || !id) return;
    const sourceKey = ref.key;
    const checked = kind === 'regex' ? checkedSources() : [];
    const ids = checked.find(s => s.refKey === sourceKey)?.ids || [id];
    const sources = ids.includes(id) ? checked : [];
    const total = sources.reduce((n, s) => n + s.ids.length, 0) || 1;
    const quickSources: QuickSource[] = sources.length
      ? sources.map(source => ({ ref: host.resources(kind).find(r => r.key === source.refKey)!, ids: source.ids })).filter(s => !!s.ref)
      : [{ ref, ids: [id] }];
    quickSources.sort((a, b) => Number(b.ref.key === ref.key) - Number(a.ref.key === ref.key));
    menu = document.createElement('div');
    menu.className = 'prw-native-menu';
    menu.setAttribute('popover', 'manual');
    menu.setAttribute('role', 'menu');
    const add = (label: string, action: () => void, danger = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('role', 'menuitem');
      if (danger) button.className = 'prw-native-danger';
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (!row.isConnected || currentRef(row, kind)?.key !== sourceKey) {
          close();
          return;
        }
        close();
        action();
      });
      menu!.append(button);
    };
    const originalRoot = document.querySelector(kind === 'preset' ? '#completion_prompt_manager_list' : ref.scope === 'global' ? '#saved_regex_scripts' : ref.scope === 'scoped' ? '#saved_scoped_scripts' : '#saved_preset_scripts');
    const originalRow = [...originalRoot?.querySelectorAll<HTMLElement>('[data-pm-identifier],.regex-script-label') || []].find(e => (e.dataset.pmIdentifier || e.dataset.regexScriptId || e.id) === id) || row;
    const original = (selector: string) => () => originalRow.querySelector<HTMLElement>(selector)?.click();
    const edit = originalRow.querySelector<HTMLElement>(
      kind === 'regex' ? '.edit_existing_regex' : '.prompt-manager-edit-action,[data-preset-prompt-action="edit"]',
    );
    add('编辑', edit ? () => edit.click() : () => editResource(ref, id));
    add(total > 1 ? `复制 · ${total} 条` : '复制', () => quick.transfer(quickSources, 'copy', false, trigger));
    add(total > 1 ? `复制到… · ${total} 条` : '复制到…', () => quick.transfer(quickSources, 'copy', true, trigger));
    add(total > 1 ? `移动到… · ${total} 条` : '移动到…', () => quick.transfer(quickSources, 'move', true, trigger));
    if (groupingEnabled()) add(quick.isRange(ref) ? '设为终点' : '分组', () => quick.group(ref, id, trigger));
    if (kind === 'regex' && originalRow.querySelector('.export_regex')) add('导出', original('.export_regex'));
    if (kind === 'preset') {
      if (originalRow.querySelector('[data-preset-prompt-action="favorite"]'))
        add('收藏', original('[data-preset-prompt-action="favorite"]'));
      if (originalRow.querySelector('[data-preset-prompt-action="global-library"]'))
        add('添加到全局库', original('[data-preset-prompt-action="global-library"]'));
      add('从列表移除', () => quick.erase(ref, id, true, row.querySelector('.completion_prompt_manager_prompt_name,.item-name')?.textContent?.trim() || id, trigger));
    }
    add('删除…', () => quick.erase(ref, id, false, row.querySelector('.regex_script_name,.completion_prompt_manager_prompt_name,.item-name')?.textContent?.trim() || id, trigger), true);
    menu.addEventListener('pointerdown', e => e.stopPropagation());
    (trigger.closest('#regex_container') || document.body).append(menu);
    menu.showPopover();
    const rect = trigger.getBoundingClientRect(),
      bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - bounds.width - 8, rect.right - bounds.width))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - bounds.height - 8, rect.bottom + 5))}px`;
    menu.querySelector('button')?.focus({ preventScroll: true });
  }
  function enhance(row: HTMLElement, kind: 'preset' | 'regex') {
    if (row.querySelector('.prw-row-more')) return;
    row.classList.add(kind === 'regex' ? 'prw-enhanced-regex' : 'prw-enhanced-preset');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'prw-row-more';
    button.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>';
    button.title = '更多';
    button.setAttribute('aria-label', '更多');
    button.setAttribute('aria-haspopup', 'menu');
    const controls =
      kind === 'regex'
        ? row.querySelector('.edit_existing_regex')?.parentElement
        : row.querySelector('.prompt_manager_prompt_controls');
    (controls || row).append(button);
    button.addEventListener(
      'click',
      event => {
        event.preventDefault();
        event.stopPropagation();
        show(row, button, kind);
      },
      { signal },
    );
    button.addEventListener('pointerdown', event => event.stopPropagation(), { signal });
  }
  function scan() {
    if (nativeDragBusy()) return;
    document
      .querySelectorAll<HTMLElement>('#regex_container .regex-script-label')
      .forEach(row => enhance(row, 'regex'));
    document
      .querySelectorAll<HTMLElement>(
        '#completion_prompt_manager_list .completion_prompt_manager_prompt[data-pm-identifier]',
      )
      .forEach(row => enhance(row, 'preset'));
    const toolbar = document.querySelector('#bulk_export_regex')?.parentElement;
    if (toolbar && !toolbar.querySelector('.prw-bulk-actions')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu_button prw-bulk-actions';
      button.textContent = '复制 / 移动';
      button.addEventListener(
        'click',
        event => {
          event.preventDefault();
          event.stopPropagation();
          const sources = checkedSources();
          const refs = host.resources('regex');
          const selected = sources.map(source => ({ ref: refs.find(r => r.key === source.refKey)!, ids: source.ids })).filter(s => !!s.ref);
          if (selected.length) quick.transfer(selected, 'copy', true, button);
        },
        { signal },
      );
      toolbar.insertBefore(button, document.querySelector('#bulk_export_regex'));
      document.querySelector('#regex_container')?.classList.add('prw-bulk-ready');
    }
    groups?.scan();
    document.dispatchEvent(new Event('prw:runtime-sync'));
  }
  let scheduled = false;
  const observer = new MutationObserver(records => {
    if (nativeDragBusy()) return;
    const own = (node: Node) => node instanceof Element && !!node.closest('.prw-native-group-header,.prw-row-more,.prw-bulk-actions,.prw-native-menu,#prw-quick-root');
    if (records.every(r => own(r.target) || [...r.addedNodes, ...r.removedNodes].every(own))) return;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      scan();
    });
  });
  for (const selector of ['#openai_settings', '#regex_container']) {
    const root = document.querySelector(selector);
    if (root) observer.observe(root, { subtree: true, childList: true });
  }
  groups = installNativeGroupViews(host, {
    enable: (ref, id, enabled) => quick.groupEnabled(ref, id, enabled),
  });
  const operations = new QuickOperations(host, guard, refs => groups?.invalidate(refs));
  const stopDrag = installNativeRegexDrag(row => currentRef(row, 'regex'),
    (ref, id, target) => operations.reorderRegex(ref, id, target.id, target.after, target.groupId), quick.fail);
  const stopPresetDrag = installNativePresetDrag(row => currentRef(row, 'preset'), guard,
    (ref, id, groupId, order) => operations.nativePresetGroup(ref, id, groupId, order), quick.fail);
  document.addEventListener('prw:native-drag-start', close, { signal });
  document.addEventListener('prw:native-drag-end', scan, { signal });
  scan();
  document.addEventListener(
    'pointerdown',
    event => {
      if (!(event.target as Element)?.closest('.prw-native-menu,.prw-row-more')) close();
    },
    { signal },
  );
  document.addEventListener(
    'keydown',
    event => {
      if (!menu) return;
      if (event.key === 'Escape') close();
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = [...menu.querySelectorAll('button')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    },
    { signal },
  );
  window.addEventListener('resize', close, { signal });
  document.addEventListener('scroll', event => { if (menu && !menu.contains(event.target as Node)) close(); }, { capture: true, passive: true, signal });
  const c = window.SillyTavern?.getContext(),
    events = ['OAI_PRESET_CHANGED_AFTER', 'CHAT_CHANGED', 'MAIN_API_CHANGED']
      .map(k => c?.eventTypes[k])
      .filter(Boolean);
  const invalidate = () => { close(); quick.reset(); groups?.invalidate(); scan(); };
  for (const event of events) c.eventSource.on(event, invalidate);
  return () => {
    close();
    stopDrag();
    stopPresetDrag();
    groups?.destroy();
    quick.destroy();
    abort.abort();
    observer.disconnect();
    for (const event of events) c.eventSource.removeListener(event, invalidate);
    document.querySelectorAll('.prw-row-more,.prw-bulk-actions,.prw-own-groups').forEach(e => e.remove());
    document.querySelectorAll('.prw-own-hidden').forEach(e => e.classList.remove('prw-own-hidden'));
    document.querySelector('#regex_container')?.classList.remove('prw-bulk-ready');
    document
      .querySelectorAll('.prw-enhanced-regex,.prw-enhanced-preset')
      .forEach(e => e.classList.remove('prw-enhanced-regex', 'prw-enhanced-preset'));
  };
}
