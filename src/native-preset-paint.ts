const ROW = ':scope > [data-pm-identifier]';
const signatures = new WeakMap<Element, Map<string, string>>();
const frames = new WeakMap<object, { list: HTMLElement; order: string[]; stamps: Map<string, string> }>();
const validRow = (row: HTMLElement, prefix: string) => row.querySelector(`.${prefix}prompt_manager_prompt_name`) &&
  row.querySelector('.prompt_manager_prompt_tokens') && row.querySelectorAll('.prompt_manager_prompt_controls > span').length >= 3;
function changed(element: Element, key: string, value: string, previous: string) {
  let values = signatures.get(element);
  if (!values) { values = new Map(); signatures.set(element, values); }
  const before = values.get(key) ?? previous;
  values.set(key, value);
  return before !== value;
}
function part(row: HTMLElement, next: HTMLElement, selector: string) {
  const old = row.querySelector<HTMLElement>(selector), fresh = next.querySelector<HTMLElement>(selector);
  if (!old || !fresh) throw new Error('原生条目结构不支持局部刷新');
  if (changed(row, selector, fresh.outerHTML, old.outerHTML)) old.replaceWith(fresh);
}
function updateRow(row: HTMLElement, next: HTMLElement, prefix: string) {
  const nativeClasses = (e: HTMLElement) => [...e.classList].filter(c => c.startsWith(`${prefix}prompt_manager_`));
  const classes = nativeClasses(next);
  for (const c of nativeClasses(row)) if (!classes.includes(c)) row.classList.remove(c);
  for (const c of classes) if (!row.classList.contains(c)) row.classList.add(c);
  part(row, next, `.${prefix}prompt_manager_prompt_name`);
  part(row, next, '.prompt_manager_prompt_tokens');
  const oldControls = row.querySelector('.prompt_manager_prompt_controls')!;
  const newControls = next.querySelector('.prompt_manager_prompt_controls')!;
  // Only the three native action slots belong to the native renderer. Keep extension buttons.
  const slots = [...oldControls.children].filter(e => e.tagName === 'SPAN' && !e.className.includes('prw-')).slice(0, 3);
  [...newControls.children].forEach((fresh, i) => {
    const old = slots[i];
    if (!old) throw new Error('原生操作按钮结构不支持局部刷新');
    if (!changed(row, `control:${i}`, fresh.outerHTML, old.outerHTML)) return;
    if (old.matches('.prompt-manager-toggle-action') && fresh.matches('.prompt-manager-toggle-action')) {
      for (const icon of ['fa-toggle-on', 'fa-toggle-off']) old.classList.toggle(icon, fresh.classList.contains(icon));
    } else old.replaceWith(fresh);
  });
}

/** Render with Tavern's own templates/handlers into a detached receiver, never into live DOM. */
export async function prepareNativePreset(manager: any, tokensPending: boolean | 'failed', incremental = true) {
  const stage = Object.create(manager);
  stage.containerElement = document.createElement('div');
  stage.listElement = null;
  // A render may cross template awaits. Snapshot arrays so a later edit/switch cannot mix frames.
  stage.serviceSettings = { ...manager.serviceSettings,
    prompts: manager.serviceSettings.prompts.map((p: any) => p && { ...p }),
    prompt_order: structuredClone(manager.serviceSettings.prompt_order) };
  stage.activeCharacter = manager.activeCharacter && { ...manager.activeCharacter };
  stage.tokenUsage = tokensPending === 'failed' ? '—' : tokensPending ? '…' : manager.tokenUsage;
  const counts = tokensPending ? {} : { ...manager.tokenHandler.getCounts() };
  stage.tokenHandler = { getCounts: () => counts };
  if (tokensPending) { stage.error = null; stage.overriddenPrompts = []; }
  // Native templates repeatedly find the same prompt/order entry. Index the snapshot once.
  const prompts = new Map(stage.serviceSettings.prompts.filter(Boolean).map((p: any) => [p.identifier, p]));
  const order = stage.getPromptOrderForCharacter(stage.activeCharacter) || [];
  const orders = new Map(order.map((entry: any) => [entry.identifier, entry]));
  stage.getPromptById = (id: string) => prompts.get(id);
  stage.getPromptOrderEntry = (_character: any, id: string) => orders.get(id);
  const ordered = stage.getPromptsForCharacter(stage.activeCharacter).filter(Boolean);
  const ids: string[] = ordered.map((p: any) => p.identifier);
  const stamps = new Map<string, string>(ordered.map((p: any) => [p.identifier, JSON.stringify([
    { ...p, content: undefined }, orders.get(p.identifier), counts[p.identifier],
    stage.overriddenPrompts?.includes(p.identifier), stage.activeCharacter,
    p.identifier === 'chatHistory' ? [stage.tokenUsage, stage.serviceSettings.openai_max_context,
      stage.serviceSettings.openai_max_tokens, stage.configuration.warningTokenThreshold, stage.configuration.dangerTokenThreshold] : null,
  ])]));
  const before = frames.get(manager), liveRows = manager.listElement ? [...manager.listElement.querySelectorAll(ROW)] as HTMLElement[] : [];
  const partial = incremental && !!before && before.list === manager.listElement && ids.length === before.order.length &&
    ids.every((id, i) => id === before.order[i] && liveRows[i]?.dataset.pmIdentifier === id) &&
    liveRows.length === ids.length && liveRows.every(row => validRow(row, manager.configuration.prefix)) &&
    !manager.containerElement.querySelector(`.${manager.configuration.prefix}prompt_manager_error`) && !stage.error;
  stage.getPromptsForCharacter = () => partial ? ordered.filter((p: any) => before!.stamps.get(p.identifier) !== stamps.get(p.identifier)) : ordered;
  stage.prwFrame = { order: ids, stamps, partial };
  await manager.renderPromptManager.call(stage);
  await manager.renderPromptManagerListItems.call(stage);
  if (!(stage.listElement instanceof HTMLElement) || !stage.containerElement.contains(stage.listElement))
    throw new Error('原生提示词模板不支持离线刷新');
  const rows = [...stage.listElement.querySelectorAll(ROW)] as HTMLElement[];
  if (ids.some(id => !id) || new Set(ids).size !== ids.length || rows.length !== stage.getPromptsForCharacter().length)
    throw new Error('原生条目ID重复或缺失');
  return stage;
}

/** Keep row identities, injected controls, focus, scroll and the existing Sortable callback. */
export function publishNativePreset(manager: any, stage: any, retain: boolean) {
  const container = manager.containerElement as HTMLElement, prefix = manager.configuration.prefix;
  const freshList = stage.listElement as HTMLElement;
  const list = container.querySelector<HTMLElement>(`#${CSS.escape(freshList.id)}`);
  const rows = list ? [...list.querySelectorAll<HTMLElement>(ROW)] : [];
  const freshRows = [...freshList.querySelectorAll<HTMLElement>(ROW)];
  const valid = (r: HTMLElement) => validRow(r, prefix);
  const oldHeader = container.querySelector(`.${prefix}prompt_manager_header`);
  const freshHeader = stage.containerElement.querySelector(`.${prefix}prompt_manager_header`);
  const oldSelect = container.querySelector('select'), freshSelect = stage.containerElement.querySelector('select');
  const selected = oldSelect?.value;
  const reusable = retain && list && oldHeader && freshHeader && oldSelect && freshSelect &&
    rows.length === list.querySelectorAll('[data-pm-identifier]').length &&
    new Set(rows.map(r => r.dataset.pmIdentifier)).size === rows.length && rows.every(valid) && freshRows.every(valid) &&
    !container.querySelector(`.${prefix}prompt_manager_error`) && !stage.error;
  if (!reusable) {
    if (stage.prwFrame?.partial) throw new Error('原生列表结构已改变，无法局部刷新');
    container.replaceChildren(...stage.containerElement.childNodes);
    manager.listElement = freshList;
    manager.makeDraggable();
  } else {
    const byId = new Map(rows.map(r => [r.dataset.pmIdentifier!, r]));
    const desired = new Set<string>(stage.prwFrame?.order || freshRows.map(r => r.dataset.pmIdentifier!));
    let structural = false;
    for (const row of rows) if (!desired.has(row.dataset.pmIdentifier!)) { row.remove(); structural = true; }
    const freshById = new Map(freshRows.map(r => [r.dataset.pmIdentifier!, r]));
    let previous: HTMLElement | undefined;
    for (const id of desired) {
      const fresh = freshById.get(id), row = byId.get(id) || fresh!;
      if (fresh && row !== fresh) updateRow(row, fresh, prefix);
      const currentRows = previous
        ? (() => { let e = previous!.nextElementSibling; while (e && !e.hasAttribute('data-pm-identifier')) e = e.nextElementSibling; return e; })()
        : list.querySelector(ROW);
      if (currentRows !== row) {
        if (currentRows) currentRows.before(row); else list.append(row);
        structural = true;
      }
      previous = row;
    }
    const oldTotal = oldHeader.lastElementChild, newTotal = freshHeader.lastElementChild;
    if (oldTotal && newTotal && !oldTotal.classList.contains(`${prefix}prompt_manager_header_advanced`) &&
      changed(oldHeader, 'total', newTotal.innerHTML, oldTotal.innerHTML)) oldTotal.replaceChildren(...newTotal.childNodes);
    if (changed(oldSelect, 'options', freshSelect.innerHTML, oldSelect.innerHTML)) oldSelect.replaceChildren(...freshSelect.childNodes);
    manager.listElement = list;
    const jq = (window as any).jQuery, instance = jq?.(list).data('ui-sortable');
    if (!instance) manager.makeDraggable();
    else if (structural) instance.refresh();
  }
  const select = container.querySelector('select');
  if (select && [...select.options].some(o => o.value === selected)) select.value = selected!;
  if (stage.prwFrame) frames.set(manager, { ...stage.prwFrame, list: manager.listElement });
}
