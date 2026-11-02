import { createApp, h, markRaw, shallowRef } from 'vue';
import NativeGroups from './NativeGroups.vue';
import { nativeModel } from './native-model';
import type { NativeModel } from './native-model';
import type { Host, Resource } from './types';

interface Actions {
  more(row: HTMLElement, button: HTMLElement, kind: Resource['kind']): void;
  fold(ref: Resource, id: string): Promise<void>;
  enable(ref: Resource, id: string, enabled: boolean): Promise<void>;
  entry(ref: Resource, id: string, enabled: boolean): Promise<void>;
  edit(ref: Resource, id: string): void;
}
export function installNativeGroupViews(host: Host, actions: Actions) {
  const cache = new Map<string, NativeModel | undefined>(), loading = new Set<string>();
  const views = new Map<string, { root: HTMLElement; mount: HTMLElement; model: ReturnType<typeof shallowRef<NativeModel>>; app: ReturnType<typeof createApp> }>();
  let epoch = 0, stopped = false, timer: ReturnType<typeof setTimeout> | undefined, queued = false;
  const pending = new Set<string>();
  function remove(key: string) {
    const view = views.get(key); if (!view) return;
    view.app.unmount(); view.mount.remove(); view.root.classList.remove('prw-native-original'); views.delete(key);
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
  function selection(root: HTMLElement, id: string, checked: boolean) {
    const row = [...root.querySelectorAll<HTMLElement>('.regex-script-label')].find(e => (e.dataset.regexScriptId || e.id) === id);
    const checkbox = row?.querySelector<HTMLInputElement>('.regex_bulk_checkbox');
    if (checkbox) { checkbox.checked = checked; checkbox.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  function scan() {
    if (stopped) return;
    const current = scopes(), seen = new Set(current.map(s => s.ref.key));
    for (const key of views.keys()) if (!seen.has(key)) remove(key);
    for (const { root, ref } of current) {
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
      if (view && (view.root !== root || !view.mount.isConnected)) { remove(ref.key); view = undefined; }
      if (!view) {
        const mount = document.createElement('div'); mount.className = 'prw-native-group-mount'; mount.dataset.resourceKey = ref.key;
        root.insertAdjacentElement('afterend', mount);
        const holder = shallowRef(markRaw(model));
        const app = createApp({ setup: () => () => h(NativeGroups, {
          model: holder.value,
          fold: (id: string) => actions.fold(holder.value.ref, id),
          enable: (id: string, enabled: boolean) => actions.enable(holder.value.ref, id, enabled),
          entry: (id: string, enabled: boolean) => actions.entry(holder.value.ref, id, enabled),
          more: (row: HTMLElement, button: HTMLElement) => actions.more(row, button, holder.value.ref.kind),
          edit: (id: string) => actions.edit(holder.value.ref, id),
          select: (id: string, checked: boolean) => selection(root, id, checked),
        }) });
        app.mount(mount); view = { root, mount, model: holder, app }; views.set(ref.key, view);
      } else if (view.model.value !== model) view.model.value = markRaw(model);
      root.classList.add('prw-native-original');
    }
  }
  function invalidate(refs?: Resource[]) {
    if (stopped) return;
    for (const key of refs?.map(r => r.key) || cache.keys()) pending.add(key);
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false; if (stopped) return;
      epoch++; loading.clear(); for (const key of pending) cache.delete(key); pending.clear(); scan();
    });
  }
  function owned(node: Node) {
    return node instanceof Element && !!node.closest('.prw-native-group-mount,.prw-row-more,.prw-bulk-actions,#prw-quick-root,.prw-native-menu');
  }
  const observer = new MutationObserver(records => {
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
  document.addEventListener('prw:resources-saved', saved);
  return {
    scan, invalidate,
    destroy() { stopped = true; epoch++; clearTimeout(timer); observer.disconnect(); document.removeEventListener('prw:resources-saved', saved); for (const key of views.keys()) remove(key); },
  };
}
