import type { Host, OpenRequest, Resource } from './types';

export function installNativeMenus(host: Host, open: (request: OpenRequest) => void): () => void {
  const abort = new AbortController(),
    signal = abort.signal;
  let menu: HTMLDivElement | undefined;
  function close() {
    menu?.remove();
    menu = undefined;
  }
  const currentRef = (row: HTMLElement, kind: 'preset' | 'regex'): Resource | undefined => {
    const resources = host.resources(kind);
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
    for (const checkbox of document.querySelectorAll<HTMLInputElement>(
      '#regex_container .regex_bulk_checkbox:checked',
    )) {
      const row = checkbox.closest<HTMLElement>('.regex-script-label');
      if (!row) continue;
      const resource = currentRef(row, 'regex'),
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
    const request = (action: OpenRequest['action']) =>
      open({ kind, refKey: sourceKey, entryId: id, ids: ids.includes(id) ? ids : [id], sources, action });
    const original = (selector: string) => () => row.querySelector<HTMLElement>(selector)?.click();
    const edit = row.querySelector<HTMLElement>(
      kind === 'regex' ? '.edit_existing_regex' : '.prompt-manager-edit-action,[data-preset-prompt-action="edit"]',
    );
    add('编辑', edit ? () => edit.click() : () => request('edit'));
    add(total > 1 ? `复制到… · ${total} 条` : '复制到…', () => request('copy'));
    add(total > 1 ? `移动到… · ${total} 条` : '移动到…', () => request('move'));
    add('从这里分组', () => request('group'));
    if (kind === 'regex' && row.querySelector('.export_regex')) add('导出', original('.export_regex'));
    if (kind === 'preset') {
      if (row.querySelector('[data-preset-prompt-action="favorite"]'))
        add('收藏', original('[data-preset-prompt-action="favorite"]'));
      if (row.querySelector('[data-preset-prompt-action="global-library"]'))
        add('添加到全局库', original('[data-preset-prompt-action="global-library"]'));
      add('从列表移除', () => request('detach'));
    }
    add('删除…', () => request('delete'), true);
    menu.addEventListener('pointerdown', e => e.stopPropagation());
    (trigger.closest('#regex_container') || document.body).append(menu);
    menu.showPopover();
    const rect = trigger.getBoundingClientRect(),
      bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - bounds.width - 8, rect.right - bounds.width))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - bounds.height - 8, rect.bottom + 5))}px`;
    menu.querySelector('button')?.focus();
  }
  function enhance(row: HTMLElement, kind: 'preset' | 'regex') {
    if (row.querySelector('.prw-row-more')) return;
    row.classList.add(kind === 'regex' ? 'prw-enhanced-regex' : 'prw-enhanced-preset');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'prw-row-more menu_button';
    button.textContent = '⋯';
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
          if (sources.length)
            open({ kind: 'regex', refKey: sources[0].refKey, ids: sources[0].ids, sources, action: 'copy' });
        },
        { signal },
      );
      toolbar.insertBefore(button, document.querySelector('#bulk_export_regex'));
      document.querySelector('#regex_container')?.classList.add('prw-bulk-ready');
    }
  }
  let scheduled = false;
  const observer = new MutationObserver(() => {
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
  const c = window.SillyTavern?.getContext(),
    events = ['OAI_PRESET_CHANGED_AFTER', 'CHAT_CHANGED', 'MAIN_API_CHANGED']
      .map(k => c?.eventTypes[k])
      .filter(Boolean);
  for (const event of events) c.eventSource.on(event, close);
  return () => {
    close();
    abort.abort();
    observer.disconnect();
    for (const event of events) c.eventSource.removeListener(event, close);
    document.querySelectorAll('.prw-row-more,.prw-bulk-actions').forEach(e => e.remove());
    document.querySelector('#regex_container')?.classList.remove('prw-bulk-ready');
    document
      .querySelectorAll('.prw-enhanced-regex,.prw-enhanced-preset')
      .forEach(e => e.classList.remove('prw-enhanced-regex', 'prw-enhanced-preset'));
  };
}
