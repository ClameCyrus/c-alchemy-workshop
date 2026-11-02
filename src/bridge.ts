import type { Group, Host, OpenRequest, Resource } from './types';
import { createQuickUI } from './quick-ui';
import type { QuickSource } from './quick-operations';

export function installNativeMenus(host: Host, open: (request: OpenRequest) => void, guard: (ref: Resource) => void = () => {}): () => void {
  const groupCache = new Map<string, Group[]>(), loadingGroups = new Set<string>();
  let disposed = false, groupEpoch = 0;
  const quick = createQuickUI(host, guard, refs => {
    groupEpoch++; loadingGroups.clear(); refs.forEach(ref => groupCache.delete(ref.key)); scan();
  });
  const abort = new AbortController(),
    signal = abort.signal;
  let menu: HTMLDivElement | undefined;
  function close() {
    menu?.remove();
    menu = undefined;
  }
  const currentRef = (row: HTMLElement, kind: 'preset' | 'regex', resources = host.resources(kind)): Resource | undefined => {
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
      '#regex_container .regex_bulk_checkbox:checked',
    )) {
      const row = checkbox.closest<HTMLElement>('.regex-script-label');
      if (!row) continue;
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
    const request = (action: OpenRequest['action']) =>
      open({ kind, refKey: sourceKey, entryId: id, ids: ids.includes(id) ? ids : [id], sources, action });
    const original = (selector: string) => () => row.querySelector<HTMLElement>(selector)?.click();
    const edit = row.querySelector<HTMLElement>(
      kind === 'regex' ? '.edit_existing_regex' : '.prompt-manager-edit-action,[data-preset-prompt-action="edit"]',
    );
    add('编辑', edit ? () => edit.click() : () => request('edit'));
    add(total > 1 ? `复制 · ${total} 条` : '复制', () => quick.transfer(quickSources, 'copy', false, trigger));
    add(total > 1 ? `复制到… · ${total} 条` : '复制到…', () => quick.transfer(quickSources, 'copy', true, trigger));
    add(total > 1 ? `移动到… · ${total} 条` : '移动到…', () => quick.transfer(quickSources, 'move', true, trigger));
    add(quick.isRange(ref) ? '设为终点' : '分组', () => quick.group(ref, id, trigger));
    if (kind === 'regex' && row.querySelector('.export_regex')) add('导出', original('.export_regex'));
    if (kind === 'preset') {
      if (row.querySelector('[data-preset-prompt-action="favorite"]'))
        add('收藏', original('[data-preset-prompt-action="favorite"]'));
      if (row.querySelector('[data-preset-prompt-action="global-library"]'))
        add('添加到全局库', original('[data-preset-prompt-action="global-library"]'));
      add('从列表移除', () => quick.erase(ref, id, true, row.querySelector('.completion_prompt_manager_prompt_name')?.textContent?.trim() || id, trigger));
    }
    add('删除…', () => quick.erase(ref, id, false, row.querySelector('.regex_script_name,.completion_prompt_manager_prompt_name')?.textContent?.trim() || id, trigger), true);
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
    renderOwnGroups();
  }
  function renderOwnGroups() {
    const scopes = new Map<string, { ref: Resource; root: HTMLElement; rows: HTMLElement[] }>();
    const resources: Partial<Record<'preset' | 'regex', Resource[]>> = {};
    for (const row of document.querySelectorAll<HTMLElement>('.prw-enhanced-preset,.prw-enhanced-regex')) {
      if (row.closest('.bai-bai-regex-vue-list,.bai-bai-preset-vue-list-host')) continue;
      const kind = row.classList.contains('prw-enhanced-preset') ? 'preset' : 'regex';
      const ref = currentRef(row, kind, resources[kind] ||= host.resources(kind));
      const root = row.closest<HTMLElement>(kind === 'preset' ? '#completion_prompt_manager_list' : '#saved_regex_scripts,#saved_scoped_scripts,#saved_preset_scripts') || row.parentElement;
      if (!ref || !root) continue;
      const scope = scopes.get(ref.key) || { ref, root, rows: [] };
      scope.rows.push(row); scopes.set(ref.key, scope);
    }
    for (const [key, scope] of scopes) {
      if (!groupCache.has(key)) {
        if (!loadingGroups.has(key)) {
          loadingGroups.add(key);
          const epoch = groupEpoch;
          void host.load(scope.ref).then(snapshot => {
            if (!disposed && epoch === groupEpoch) { groupCache.set(key, snapshot.own?.groups || []); renderOwnGroups(); }
          }).catch(error => {
            if (epoch === groupEpoch) groupCache.set(key, []);
            console.warn('[Cの炼金工坊] 读取原生分组失败', error);
          }).finally(() => { if (epoch === groupEpoch) loadingGroups.delete(key); });
        }
        continue;
      }
      const groups = groupCache.get(key)!;
      const hidden = new Set(groups.filter(g => g.collapsed).flatMap(g => g.members));
      for (const row of scope.rows) row.classList.toggle('prw-own-hidden', hidden.has(row.dataset.pmIdentifier || row.dataset.regexScriptId || row.id));
      let bar = [...scope.root.querySelectorAll<HTMLElement>('.prw-own-groups')].find(e => e.dataset.resourceKey === key);
      if (!groups.length) { bar?.remove(); continue; }
      const fingerprint = JSON.stringify(groups);
      if (bar?.dataset.fingerprint === fingerprint) continue;
      bar?.remove(); bar = document.createElement(scope.root.tagName === 'UL' || scope.root.tagName === 'OL' ? 'li' : 'div');
      bar.className = 'prw-own-groups'; bar.dataset.resourceKey = key; bar.dataset.fingerprint = fingerprint;
      for (const group of groups) {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = `${group.collapsed ? '▸' : '▾'} ${group.name} · ${group.members.length}`;
        button.setAttribute('aria-label', `${group.collapsed ? '展开' : '折叠'} ${group.name}`);
        button.addEventListener('click', event => { event.stopPropagation(); quick.collapse(scope.ref, group.id); }, { signal });
        bar.append(button);
      }
      scope.root.prepend(bar);
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
  const invalidate = () => { close(); quick.reset(); groupEpoch++; groupCache.clear(); loadingGroups.clear(); scan(); };
  for (const event of events) c.eventSource.on(event, invalidate);
  return () => {
    close();
    disposed = true;
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
