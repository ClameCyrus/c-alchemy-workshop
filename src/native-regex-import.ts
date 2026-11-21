import { makeDocument } from './core';
import { readPreferences } from './preferences';
import { groupedRegexSnapshot, importGroups, type ImportGroup } from './regex-import';
import type { Host, Raw, Resource, Scope } from './types';

interface ImportPopup {
  dlg: HTMLDialogElement;
  result: number | null;
  onClosing?: (popup: ImportPopup) => boolean | Promise<boolean>;
}

export function installRegexImport(host: Host, guard: (ref: Resource) => void) {
  const stop = new AbortController();
  const cleanups = new Set<() => void>();
  const context = () => window.SillyTavern?.getContext?.();
  function resource(scope: Scope) {
    const c = context();
    if (scope === 'preset' && c?.getPresetManager?.()?.apiId !== 'openai') return;
    const avatar = c?.characters?.[c.characterId]?.avatar;
    if (scope === 'scoped' && (c?.groupId || !avatar)) return;
    return host.resources('regex').find(ref => ref.scope === scope &&
      (scope === 'global' || (scope === 'preset' ? ref.live : ref.avatar === avatar)));
  }
  function attach(dialog: HTMLDialogElement) {
    const radio = dialog.querySelector<HTMLInputElement>('#regex_import_target_global');
    const filesInput = document.querySelector<HTMLInputElement>('#import_regex_file');
    if (!radio || !filesInput?.files?.length || !readPreferences().regexImportGroup) return;
    const popup: ImportPopup | undefined = context()?.Popup?.util?.popups?.find((item: ImportPopup) => item.dlg === dialog);
    if (!popup) return;
    const files = Array.from(filesInput.files);
    const row = document.createElement('label');
    row.className = 'prw-import-group';
    row.textContent = '目标分组';
    const select = document.createElement('select');
    row.append(select);
    radio.closest('label')?.parentElement?.append(row);
    const error = document.createElement('small');
    error.setAttribute('role', 'alert');
    row.after(error);
    const scope = () => dialog.querySelector<HTMLInputElement>('input[name=regex_import_target]:checked')?.value as Scope;
    let choices: ImportGroup[] = [], target: Resource | undefined;
    let generation = 0, busy = false, finished = false, saved: Resource | undefined;
    async function update() {
      const revision = ++generation;
      row.hidden = true;
      select.replaceChildren(new Option('不指定分组', ''));
      choices = [];
      error.textContent = '';
      try {
        target = resource(scope());
        if (!target) return;
        const doc = makeDocument(target, await host.load(target));
        if (revision !== generation) return;
        choices = importGroups(doc);
        const schemes = new Set(choices.map(item => item.label));
        const optgroups = new Map<string, HTMLOptGroupElement>();
        choices.forEach((item, i) => {
          let parent: HTMLSelectElement | HTMLOptGroupElement = select;
          if (schemes.size > 1) {
            let group = optgroups.get(item.label);
            if (!group) {
              group = document.createElement('optgroup');
              group.label = item.label;
              select.append(group);
              optgroups.set(item.label, group);
            }
            parent = group;
          }
          parent.append(new Option(item.name, String(i)));
        });
        row.hidden = !choices.length;
      } catch (cause) {
        if (revision === generation) console.warn('[Cの炼金工坊] 无法读取导入目标的分组', cause);
      }
    }
    const change = (event: Event) => {
      if ((event.target as Element).matches('input[name=regex_import_target]')) void update();
    };
    dialog.addEventListener('input', change);
    const previous = popup.onClosing;
    const closing = async (instance: ImportPopup) => {
      if (busy || finished) return false;
      busy = true;
      try {
        const result = instance.result;
        if (previous && !await previous.call(instance, instance)) return false;
        if (result !== (context()?.POPUP_RESULT?.AFFIRMATIVE ?? 1)) {
          filesInput.value = '';
          finished = true;
          return true;
        }
        if (!select.value) { finished = true; return true; }
        const choice = choices[Number(select.value)];
        const ref = target;
        if (!ref || !choice) throw new Error('请重新选择目标分组');
        const assertTarget = () => {
          const current = resource(scope());
          if (stop.signal.aborted || current?.key !== ref.key || current?.name !== ref.name || !readPreferences().regexImportGroup)
            throw new Error('导入目标已变化，请重新选择');
          guard(ref);
        };
        assertTarget();
        const scripts: Raw[] = [];
        for (const file of files) {
          let data: unknown;
          try { data = JSON.parse(await file.text()); }
          catch { throw new Error(file.name + ' 无法读取为 JSON'); }
          for (const script of Array.isArray(data) ? data : [data]) {
            if (typeof script?.scriptName !== 'string' || !script.scriptName.trim())
              throw new Error(file.name + ' 含有缺少名称的正则');
            scripts.push(script);
          }
        }
        if (!scripts.length) throw new Error('文件中没有正则');
        const doc = makeDocument(ref, await host.load(ref));
        assertTarget();
        const snapshot = groupedRegexSnapshot(doc, scripts, choice);
        await host.commit([{ doc, snapshot }]);
        // The native handler reads this input after its popup resolves.
        filesInput.value = '';
        saved = ref;
        finished = true;
        (window as any).toastr?.success?.(`已导入 ${scripts.length} 条正则到「${choice.name}」`, undefined, { escapeHtml: true });
        return true;
      } catch (cause) {
        error.textContent = (cause as Error).message;
        return false;
      } finally { busy = false; }
    };
    popup.onClosing = closing;
    function cleanup() {
      ++generation;
      dialog.removeEventListener('input', change);
      dialog.removeEventListener('close', cleanup);
      if (popup?.onClosing === closing) popup.onClosing = previous;
      row.remove(); error.remove();
      cleanups.delete(cleanup);
      if (saved) {
        const ref = saved;
        document.dispatchEvent(new CustomEvent('prw:resources-saved', { detail: [ref] }));
        void host.refresh([ref]).catch(cause => console.warn('[Cの炼金工坊] 正则已保存，刷新失败', cause));
      }
    }
    cleanups.add(cleanup);
    dialog.addEventListener('close', cleanup, { once: true });
    void update();
  }
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes)
      if (node instanceof HTMLDialogElement) attach(node);
  });
  observer.observe(document.body, { childList: true });
  return () => { stop.abort(); observer.disconnect(); cleanups.forEach(cleanup => cleanup()); };
}
