import { readPreferences } from './preferences';
import type { Host } from './types';

type WorldbookSources = Record<string, string[]>;

function button(label: string, action: () => void, className = '') {
  const result = document.createElement('button');
  result.type = 'button';
  result.className = className;
  result.textContent = label;
  result.addEventListener('click', action);
  return result;
}

function connect(select: HTMLSelectElement, title: string, sources: () => WorldbookSources, inspect: (name: string) => void) {
  const jq = (window as any).jQuery;
  const root = document.createElement('div');
  root.className = 'prw-world-picker';
  const summary = document.createElement('div');
  summary.className = 'prw-world-selected';
  const popup = document.createElement('div');
  popup.className = 'prw-world-popup';
  popup.hidden = true;
  const toolbar = document.createElement('div');
  toolbar.className = 'prw-world-toolbar';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜索世界书';
  search.setAttribute('aria-label', search.placeholder);
  search.hidden = true;
  const searchButton = button('搜索', () => {
    search.hidden = false;
    search.focus();
  });
  const list = document.createElement('div');
  list.id = 'prw-world-options-' + select.id;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', title);
  if (select.multiple) list.setAttribute('aria-multiselectable', 'true');
  list.className = 'prw-world-options';
  const toggle = button(title, () => popup.hidden ? open() : close());
  toggle.className = 'prw-world-toggle';
  toggle.setAttribute('aria-haspopup', 'listbox');
  toggle.setAttribute('aria-controls', list.id);
  toggle.setAttribute('aria-expanded', 'false');
  toolbar.append(searchButton, search, button('收起', () => close(true)));
  popup.append(toolbar, list);
  root.append(summary, toggle, popup);
  select.classList.add('prw-world-picker-native');
  const adjacent = select.nextElementSibling;
  (adjacent?.classList.contains('select2-container') ? adjacent : select).after(root);

  function close(focus = false) {
    popup.hidden = true;
    search.hidden = true;
    search.value = '';
    toggle.setAttribute('aria-expanded', 'false');
    if (focus) toggle.focus();
  }
  function open() {
    document.dispatchEvent(new CustomEvent('prw:world-picker-open', { detail: root }));
    popup.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    render();
    list.scrollTop = 0;
  }
  function pick(option: HTMLOptionElement) {
    const selected = [...select.selectedOptions].map(value => value.value);
    const values = select.multiple
      ? (option.selected ? selected.filter(value => value !== option.value) : [...selected, option.value])
      : [option.value];
    for (const choice of select.options) choice.selected = values.includes(choice.value);
    if (jq) jq(select).trigger('change');
    else select.dispatchEvent(new Event('change', { bubbles: true }));
    if (!select.multiple) close(true);
  }
  function render(focusValue?: string) {
    const selected = [...select.selectedOptions].filter(option => option.value);
    summary.replaceChildren();
    if (select.multiple) {
      for (const option of selected.slice(0, 3)) {
        summary.append(button(option.text, () => inspect(option.text), 'prw-world-chip'));
      }
      toggle.textContent = selected.length > 3 ? `选择世界书 · 已启用 ${selected.length} 本` : '选择世界书';
    } else {
      toggle.textContent = selected[0]?.text || '选择世界书查看条目';
    }
    toggle.title = toggle.textContent;
    toggle.setAttribute('aria-label', title);
    if (popup.hidden) return;
    const active = sources();
    const globals = new Set([...document.querySelectorAll<HTMLOptionElement>('#world_info option:checked')].map(option => option.text));
    const tags = (name: string) => [...(globals.has(name) ? ['全局'] : []),
      ...(Object.hasOwn(active, name) ? active[name].filter(tag => tag !== '全局') : [])];
    const query = search.value.trim().toLowerCase();
    const options = [...select.options].filter(option => !option.hidden && !option.disabled && (option.value
      ? option.text.toLowerCase().includes(query) : !query && !select.multiple));
    const bookTags = new Map(options.map(option => [option, tags(option.text)]));
    options.sort((a, b) => Number(!!bookTags.get(b)?.length) - Number(!!bookTags.get(a)?.length));
    const fragment = document.createDocumentFragment();
    let focusOption: HTMLButtonElement | undefined;
    for (const option of options) {
      const control = button(option.value ? option.text : '清除选择', () => {
        pick(option);
        if (select.multiple) render(option.value);
      }, 'prw-world-option');
      const label = document.createElement('span');
      label.textContent = control.textContent;
      const badge = document.createElement('small');
      badge.textContent = bookTags.get(option)?.join(' · ') ?? '';
      control.replaceChildren(label, badge);
      control.setAttribute('role', 'option');
      control.setAttribute('aria-selected', String(option.selected));
      if (option.value === focusValue) focusOption = control;
      fragment.append(control);
    }
    if (!options.length) fragment.append('没有匹配的世界书');
    const scroll = list.scrollTop;
    list.replaceChildren(fragment);
    list.scrollTop = scroll;
    focusOption?.focus({ preventScroll: true });
  }
  const update = () => render();
  const outside = (event: PointerEvent) => {
    if (!popup.hidden && !root.contains(event.target as Node)) close();
  };
  const other = (event: Event) => { if ((event as CustomEvent).detail !== root) close(); };
  root.addEventListener('keydown', event => {
    if (popup.hidden) return;
    if (event.key === 'Escape') { event.stopPropagation(); close(true); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const options = [...list.querySelectorAll('button')];
    if (!options.length) return;
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
      : Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    event.preventDefault();
    options[next].focus();
  });
  search.addEventListener('input', () => { list.scrollTop = 0; render(); });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('prw:world-picker-open', other);
  document.addEventListener('prw:world-picker-sources', update);
  if (jq) jq(select).on('change.prwWorldPicker', update);
  else select.addEventListener('change', update);
  const observer = new MutationObserver(update);
  observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'hidden'] });
  render();
  return () => {
    if (jq) jq(select).off('change.prwWorldPicker', update);
    else select.removeEventListener('change', update);
    observer.disconnect();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('prw:world-picker-open', other);
    document.removeEventListener('prw:world-picker-sources', update);
    select.classList.remove('prw-world-picker-native');
    root.remove();
  };
}

export function installWorldbookPicker(host: Host) {
  let stop: (() => void)[] = [];
  let active: WorldbookSources = Object.create(null);
  let generation = 0;
  function updateSources() {
    const token = ++generation;
    void host.activeWorldbooks?.().then(value => {
      if (token !== generation) return;
      active = value;
      document.dispatchEvent(new Event('prw:world-picker-sources'));
    }).catch(() => {});
  }
  function configure() {
    stop.forEach(cleanup => cleanup());
    stop = [];
    generation++;
    if (!readPreferences().worldbookPicker) return;
    const global = document.querySelector<HTMLSelectElement>('#world_info');
    const editor = document.querySelector<HTMLSelectElement>('#world_editor_select');
    if (!global?.multiple || !editor || editor.multiple) return;
    updateSources();
    const show = (name: string) => {
      const option = [...editor.options].find(option => option.value && option.text === name);
      if (!option || option.selected) return;
      editor.value = option.value;
      const jq = (window as any).jQuery;
      if (jq) jq(editor).trigger('change');
      else editor.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const sources = () => active;
    stop = [connect(global, '全局启用世界书', sources, show), connect(editor, '选择世界书查看条目', sources, show)];
  }
  const context = window.SillyTavern?.getContext?.();
  const chatChanged = context?.eventTypes?.CHAT_CHANGED;
  const onOpen = () => { if (stop.length) updateSources(); };
  if (chatChanged) context.eventSource?.on?.(chatChanged, onOpen);
  document.addEventListener('prw:world-picker-open', onOpen);
  document.addEventListener('prw:worldbook-preference', configure);
  configure();
  return () => {
    generation++;
    stop.forEach(cleanup => cleanup());
    if (chatChanged) context.eventSource?.removeListener?.(chatChanged, onOpen);
    document.removeEventListener('prw:world-picker-open', onOpen);
    document.removeEventListener('prw:worldbook-preference', configure);
  };
}
