import { nativeModel } from './native-model';
import { nativeFolds, saveNativeFold } from './native-folds';
import { groupingEnabled } from './preferences';
import { retainNativeBodies } from './native-bodies';
import { nativeDragBusy } from './native-drag';
import type { NativeModel } from './native-model';
import type { Group, Host, Resource } from './types';

interface Actions { enable(ref: Resource, id: string, enabled: boolean): Promise<void> }
interface Section { header: HTMLElement; fold: HTMLButtonElement; power: HTMLButtonElement; group: Group }
interface View {
  root: HTMLElement; model: NativeModel; rows: Map<string, HTMLElement[]>;
  sections: Map<HTMLElement, Section>; aria: Map<Element, string | null>; busy: Set<string>;
  bodies: ReturnType<typeof retainNativeBodies>;
}
const ROW = '.completion_prompt_manager_prompt[data-pm-identifier],.regex-script-label';
const OWN = '.prw-native-group-header,.prw-row-more,.prw-bulk-actions,#prw-quick-root,.prw-native-menu';
export function installNativeGroupViews(host: Host, actions: Actions) {
  const cache = new Map<string, NativeModel | undefined>(), loading = new Set<string>(), views = new Map<string, View>();
  let epoch = 0, stopped = false, timer: ReturnType<typeof setTimeout> | undefined, queued = false;
  const pending = new Set<string>();
  function remove(key: string) {
    const view = views.get(key); if (!view) return;
    view.sections.forEach(s => s.header.remove());
    view.root.querySelectorAll('.prw-group-folded').forEach(row => row.classList.remove('prw-group-folded'));
    view.root.querySelectorAll<HTMLElement>('[data-prw-group-id]').forEach(row => delete row.dataset.prwGroupId);
    view.root.classList.remove('prw-native-grouped');
    view.bodies.restore();
    view.aria.forEach((value, element) => { if (value === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', value); });
    views.delete(key);
  }
  function scopes() {
    const result: { root: HTMLElement; ref: Resource }[] = [];
    const presets = host.resources('preset'), regexes = host.resources('regex');
    for (const [selector, ref] of [
      ['#completion_prompt_manager_list', presets.find(r => r.live) || (host.demo ? presets[0] : undefined)],
      ['#saved_regex_scripts', regexes.find(r => r.scope === 'global')],
      ['#saved_scoped_scripts', regexes.find(r => r.scope === 'scoped')],
      ['#saved_preset_scripts', regexes.find(r => r.scope === 'preset' && r.live) || (host.demo ? regexes.find(r => r.scope === 'preset') : undefined)],
    ] as const) {
      const root = document.querySelector<HTMLElement>(selector); if (root && ref) result.push({ root, ref });
    }
    return result;
  }
  function paint(view: View, id: string) {
    const group = view.model.groups.find(g => g.id === id); if (!group) return;
    const folded = nativeFolds(view.model.ref)[id] ?? group.collapsed;
    for (const row of view.rows.get(id) || []) row.classList.toggle('prw-group-folded', folded);
    for (const section of view.sections.values()) {
      if (section.group.id !== id) continue;
      section.group = group;
      const text = `${folded ? '▸' : '▾'} ${group.name}  ${view.rows.get(id)?.length || 0}`;
      if (section.fold.textContent !== text) section.fold.textContent = text;
      section.fold.setAttribute('aria-label', `${folded ? '展开' : '折叠'} ${group.name}`);
      section.fold.setAttribute('aria-expanded', String(!folded));
      const label = group.enabled ? '停用' : '启用';
      if (section.power.textContent !== label) section.power.textContent = label;
      section.power.setAttribute('aria-label', `${label} ${group.name}`);
      section.power.title = `${label}本组，保留条目开关`;
      section.power.disabled = view.busy.has(id);
      section.header.classList.toggle('prw-group-paused', !group.enabled);
    }
  }
  function decorate(view: View) {
    view.bodies.sync();
    const member = new Map(view.model.groups.flatMap(g => g.members.map(id => [id, g] as const)));
    const rows = [...view.root.querySelectorAll<HTMLElement>(ROW)].filter(row => !row.closest('.bai-bai-preset-global-library'));
    const starts = new Map<HTMLElement, Group>();
    view.rows.clear();
    let previous: HTMLElement | undefined, previousGroup = '';
    for (const row of rows) {
      const group = member.get(row.dataset.pmIdentifier || row.dataset.regexScriptId || row.id);
      if (row.dataset.prwGroupId !== (group?.id || '')) row.dataset.prwGroupId = group?.id || '';
      if (group) {
        if (previousGroup !== group.id || previous?.parentElement !== row.parentElement) starts.set(row, group);
        const members = view.rows.get(group.id) || []; members.push(row); view.rows.set(group.id, members);
      } else row.classList.remove('prw-group-folded');
      previous = row; previousGroup = group?.id || '';
    }
    for (const [row, section] of view.sections) if (!starts.has(row) || starts.get(row)!.id !== section.group.id) {
      section.header.remove(); view.sections.delete(row);
    }
    // Keep original row nodes, handlers, switches and order. Only add headers at group boundaries.
    for (const [row, group] of starts) {
      let section = view.sections.get(row);
      if (!section) {
        const header = document.createElement(row.parentElement?.tagName === 'UL' ? 'li' : 'div');
        header.className = 'prw-native-group-header'; header.dataset.groupId = group.id;
        const fold = document.createElement('button'), power = document.createElement('button');
        fold.type = power.type = 'button'; fold.className = 'prw-group-title'; power.className = 'prw-group-power';
        header.append(fold, power);
        header.addEventListener('pointerdown', e => e.stopPropagation());
        header.addEventListener('mousedown', e => e.stopPropagation());
        fold.addEventListener('click', e => {
          e.preventDefault(); e.stopPropagation();
          const current = view.model.groups.find(g => g.id === group.id); if (!current) return;
          saveNativeFold(view.model.ref, group.id, !(nativeFolds(view.model.ref)[group.id] ?? current.collapsed));
          paint(view, group.id);
        });
        power.addEventListener('click', async e => {
          e.preventDefault(); e.stopPropagation();
          const current = view.model.groups.find(g => g.id === group.id);
          if (!current || view.busy.has(group.id)) return;
          view.busy.add(group.id); paint(view, group.id);
          try { await actions.enable(view.model.ref, group.id, !current.enabled); }
          finally { view.busy.delete(group.id); paint(view, group.id); }
        });
        section = { header, fold, power, group }; view.sections.set(row, section);
      }
      if (section.header.nextElementSibling !== row) row.before(section.header);
    }
    view.root.classList.toggle('prw-native-grouped', !!starts.size);
    // Third-party wrappers stay in their original DOM. Their rows remain interactive when our group layout is active.
    for (const el of view.root.querySelectorAll('.bai-bai-regex-group-body,.bai-bai-preset-group > .bai-bai-preset-group-body')) {
      if (!view.aria.has(el)) view.aria.set(el, el.getAttribute('aria-hidden'));
      el.setAttribute('aria-hidden', 'false');
    }
    for (const group of view.model.groups) paint(view, group.id);
  }
  function scan() {
    if (stopped || nativeDragBusy()) return;
    if (!groupingEnabled()) { for (const key of views.keys()) remove(key); return; }
    const current = scopes(), seen = new Set(current.map(s => s.ref.key));
    for (const key of views.keys()) if (!seen.has(key)) remove(key);
    for (const { root, ref } of current) {
      const cached = cache.get(ref.key);
      if (cached && (cached.ref.name !== ref.name || cached.ref.avatar !== ref.avatar)) { remove(ref.key); cache.delete(ref.key); }
      if (!cache.has(ref.key)) {
        if (!loading.has(ref.key)) {
          loading.add(ref.key); const generation = epoch;
          void host.load(ref).then(snapshot => {
            if (stopped || generation !== epoch) return;
            cache.set(ref.key, nativeModel(ref, snapshot)); scan();
          }).catch(error => {
            if (generation === epoch) cache.set(ref.key, undefined);
            console.warn('[Cの炼金工坊] 原生分组读取失败', error);
          }).finally(() => { if (generation === epoch) loading.delete(ref.key); });
        }
        continue;
      }
      const model = cache.get(ref.key);
      if (!model) { remove(ref.key); continue; }
      let view = views.get(ref.key);
      if (view && view.root !== root) { remove(ref.key); view = undefined; }
      if (!view) { view = { root, model, rows: new Map(), sections: new Map(), aria: new Map(), busy: new Set(), bodies: retainNativeBodies(root) }; views.set(ref.key, view); }
      view.model = model; decorate(view);
    }
  }
  function invalidate(refs?: Resource[]) {
    if (stopped) return;
    for (const key of refs?.map(r => r.key) || cache.keys()) pending.add(key);
    if (nativeDragBusy()) return;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false; if (stopped || nativeDragBusy()) return;
      epoch++; loading.clear(); for (const key of pending) cache.delete(key); pending.clear(); scan();
    });
  }
  const owned = (node: Node) => node instanceof Element && !!node.closest(OWN);
  const observer = new MutationObserver(records => {
    if (nativeDragBusy()) return;
    const relevant = records.some(record => {
      if (owned(record.target)) return false;
      const nodes = [...record.addedNodes, ...record.removedNodes];
      if (nodes.length && nodes.every(owned)) return false;
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return !!target?.closest('#completion_prompt_manager_list,#saved_regex_scripts,#saved_scoped_scripts,#saved_preset_scripts') ||
        nodes.some(node => node instanceof Element && (node.matches('#completion_prompt_manager_list,#saved_regex_scripts,#saved_scoped_scripts,#saved_preset_scripts') || !!node.querySelector('#completion_prompt_manager_list,#saved_regex_scripts,#saved_scoped_scripts,#saved_preset_scripts')));
    });
    if (relevant) { clearTimeout(timer); timer = setTimeout(() => invalidate(), 80); }
  });
  for (const selector of ['#openai_settings', '#regex_container']) {
    const root = document.querySelector(selector); if (root) observer.observe(root, { childList: true, subtree: true });
  }
  const saved = (event: Event) => invalidate((event as CustomEvent<Resource[]>).detail);
  const groupState = (event: Event) => {
    const { ref, id, enabled } = (event as CustomEvent<{ ref: Resource; id: string; enabled: boolean }>).detail;
    const model = cache.get(ref.key);
    if (!model || model.ref.name !== ref.name || model.ref.avatar !== ref.avatar) return;
    const updated = { ...model, groups: model.groups.map(g => g.id === id ? { ...g, enabled } : g) };
    cache.set(ref.key, updated);
    const view = views.get(ref.key); if (view) { view.model = updated; if (!nativeDragBusy()) paint(view, id); }
  };
  const preference = () => { invalidate(); scan(); };
  document.addEventListener('prw:resources-saved', saved);
  document.addEventListener('prw:group-state', groupState);
  document.addEventListener('prw:grouping-preference', preference);
  const dragEnd = (e: Event) => {
    if (pending.size) invalidate([]);
    else if ((e as CustomEvent).detail?.changed) invalidate();
    else scan();
  };
  document.addEventListener('prw:native-drag-end', dragEnd);
  return {
    scan, invalidate,
    destroy() {
      stopped = true; epoch++; clearTimeout(timer); observer.disconnect();
      document.removeEventListener('prw:resources-saved', saved); document.removeEventListener('prw:group-state', groupState);
      document.removeEventListener('prw:grouping-preference', preference); for (const key of views.keys()) remove(key);
      document.removeEventListener('prw:native-drag-end', dragEnd);
    },
  };
}
