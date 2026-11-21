import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { clone, makeDocument, transferEntries } from './core';
import { saveDocuments } from './native';
import { readPreferences, writePreferences } from './preferences';
import { captureMove, restoreMove, type PendingMove } from './pending-move';
import type { Host, Kind, Resource, Side, WorkDocument } from './types';

export const useWorkbench = defineStore('c-alchemy-workshop', () => {
  const preferences = reactive(readPreferences());
  watch(preferences, () => writePreferences(preferences), { deep: true, flush: 'sync' });
  watch(() => [preferences.presetGrouping, preferences.regexGrouping], () => {
    if (typeof document !== 'undefined') document.dispatchEvent(new Event('prw:grouping-preference'));
  });
  watch(() => preferences.regexDeferredRefresh, () => {
    if (typeof document !== 'undefined') document.dispatchEvent(new Event('prw:regex-refresh-preference'));
  });
  watch(() => preferences.presetLock, () => {
    if (typeof document !== 'undefined') document.dispatchEvent(new Event('prw:lock-preference'));
  });
  watch(() => [preferences.presetSwitch, preferences.presetRefresh], () => {
    if (typeof document !== 'undefined') document.dispatchEvent(new Event('prw:preset-performance-preference'));
  });
  watch(() => preferences.worldbookPicker, () => {
    if (typeof document !== 'undefined') document.dispatchEvent(new Event('prw:worldbook-preference'));
  });
  const documents = reactive<Record<string, WorkDocument>>({});
  const kind = ref<Kind>(preferences.kind);
  const keys = reactive({ left: preferences.views[kind.value].left, right: preferences.views[kind.value].right });
  const resources = ref<Resource[]>([]);
  const selected = reactive<Record<string, string[]>>({});
  const anchor = ref<{ key: string; id: string } | null>(null);
  const operation = ref<'browse' | 'insert'>(preferences.operation);
  const transferAction = ref<'copy' | 'move'>(preferences.transfer);
  const activePage = ref<Side>(preferences.page);
  watch([operation, transferAction, activePage], () => {
    preferences.operation = operation.value;
    preferences.transfer = transferAction.value;
    preferences.page = activePage.value;
  });
  const busy = ref(false);
  const error = ref('');
  const notice = ref('');
  const history = ref<string[]>([]),
    future = ref<string[]>([]);
  const saveOrder = ref<string[]>([]);
  const moves = ref<PendingMove[]>([]);
  let host: Host;
  const requests = { left: 0, right: 0 };
  const dirty = computed(() => Object.values(documents).filter(d => d.dirty));
  const docs = computed(() => ({ left: documents[keys.left], right: documents[keys.right] }));
  function init(value: Host) {
    host = value;
    resources.value = host.resources(kind.value);
  }
  function clearSelection() {
    for (const key of Object.keys(selected)) selected[key] = [];
  }
  async function load(side: Side, key: string) {
    if (keys[side] !== key) clearSelection();
    const ticket = ++requests[side], requestedKind = kind.value;
    anchor.value = null;
    keys[side] = key;
    try {
      const resource = resources.value.find(r => r.key === key);
      if (!resource) {
        keys[side] = '';
        preferences.views[kind.value][side] = '';
        return;
      }
      if (!documents[key] || !documents[key].dirty) {
        const snapshot = await host.load(resource);
        if (ticket !== requests[side] || requestedKind !== kind.value) return;
        if (!documents[key]?.dirty) documents[key] = makeDocument(resource, snapshot);
      }
      const group = preferences.views[kind.value].groups[side];
      if (group && group !== '__ungrouped' && !documents[key]?.state.groups.some(g => g.id === group))
        preferences.views[kind.value].groups[side] = '';
      keys[side] = key;
      preferences.views[kind.value][side] = key;
      error.value = '';
    } catch (e) {
      if (ticket !== requests[side] || requestedKind !== kind.value) return;
      error.value = String(e instanceof Error ? e.message : e);
    }
  }
  async function switchKind(value: Kind) {
    if (kind.value === value) return;
    clearSelection();
    requests.left++; requests.right++;
    kind.value = value;
    preferences.kind = value;
    resources.value = host.resources(value);
    anchor.value = null;
    keys.left = preferences.views[value].left;
    keys.right = preferences.views[value].right;
    await ensureView(true);
  }
  async function ensureView(refresh = false) {
    const left = resources.value.find(r => r.key === keys.left) || resources.value[0];
    if (left && (!documents[left.key] || (refresh && !documents[left.key].dirty))) await load('left', left.key);
    else if (left) { keys.left = left.key; preferences.views[kind.value].left = left.key; }
    if (keys.right && (!documents[keys.right] || (refresh && !documents[keys.right].dirty))) await load('right', keys.right);
  }
  const snapshot = () => JSON.stringify({ documents, saveOrder: saveOrder.value, moves: moves.value });
  function restore(json: string) {
    const value = JSON.parse(json);
    Object.keys(documents).forEach(k => delete documents[k]);
    Object.assign(documents, value.documents);
    saveOrder.value = value.saveOrder;
    moves.value = value.moves;
  }
  function change(fn: () => void) {
    if (busy.value) return;
    const before = snapshot();
    try {
      fn();
      history.value.push(before);
      if (history.value.length > 30) history.value.shift();
      while (history.value.length > 1 && history.value.reduce((n, item) => n + item.length, 0) > 8_000_000)
        history.value.shift();
      future.value = [];
      error.value = '';
    } catch (e) {
      restore(before);
      error.value = e instanceof Error ? e.message : String(e);
    }
  }
  function undo() {
    if (busy.value) return;
    const value = history.value.pop();
    if (value) {
      future.value.push(snapshot());
      restore(value);
    }
  }
  function redo() {
    if (busy.value) return;
    const value = future.value.pop();
    if (value) {
      history.value.push(snapshot());
      restore(value);
    }
  }
  function transfer(
    sourceKey: string,
    targetKey: string,
    ids: string[],
    beforeId?: string,
    after = false,
    groupId?: string,
  ) {
    transferMany([{ key: sourceKey, ids }], targetKey, beforeId, after, groupId);
  }
  function transferMany(
    sources: { key: string; ids: string[] }[],
    targetKey: string,
    beforeId?: string,
    after = false,
    groupId?: string,
  ) {
    const target = documents[targetKey];
    if (!target || sources.some(s => !documents[s.key])) {
      error.value = '先选择目标';
      return;
    }
    let success = false;
    change(() => {
      let position = beforeId,
        afterPosition = after;
      for (const item of sources) {
        const move = transferAction.value === 'move' && item.key !== targetKey
          ? captureMove(documents[item.key], targetKey, item.ids) : undefined;
        const added = transferEntries(
          documents[item.key],
          target,
          item.ids,
          transferAction.value,
          position,
          afterPosition,
          groupId,
        );
        if (added.length) {
          if (move) moves.value.push(move);
          position = added[added.length - 1];
          afterPosition = true;
          success = true;
        }
      }
      if (!success) return;
      const dependency = [
        targetKey,
        ...(transferAction.value === 'move' ? sources.map(s => s.key).filter(k => k !== targetKey) : []),
      ];
      saveOrder.value = [...new Set([...dependency, ...saveOrder.value])];
    });
    if (success && !error.value) {
      clearSelection();
      notice.value = `${transferAction.value === 'copy' ? '已复制' : '已移动'} ${sources.reduce((n, s) => n + s.ids.length, 0)} 条`;
    }
  }
  function checkSaveOnly(key: string) {
    if (moves.value.some(move => move.source === key || move.target === key))
      throw new Error('此预设有尚未保存的跨预设操作，请先保存或放弃修改');
  }
  function planSave(keysToSave: string[]) {
    const picked = new Set(keysToSave);
    const remaining: PendingMove[] = [];
    const restored = new Map<string, WorkDocument>();
    for (const move of [...moves.value].reverse()) {
      const source = picked.has(move.source), target = picked.has(move.target);
      if (!source && !target) remaining.unshift(move);
      if (source === target) continue;
      const doc = restored.get(move.source) ?? clone(documents[move.source]);
      restoreMove(doc, move);
      restored.set(move.source, doc);
    }
    return {
      documents: dirty.value.filter(doc => picked.has(doc.ref.key)).map(doc => restored.get(doc.ref.key) ?? doc),
      restored,
      remaining,
    };
  }
  async function save(selection?: string | string[]) {
    if (busy.value) return false;
    busy.value = true;
    try {
      if (typeof selection === 'string') checkSaveOnly(selection);
      const keysToSave = typeof selection === 'string' ? [selection] : selection ?? dirty.value.map(doc => doc.ref.key);
      if (!keysToSave.length) return false;
      const plan = planSave(keysToSave);
      const updated = await saveDocuments(host, plan.documents, saveOrder.value);
      for (const [key, doc] of plan.restored) documents[key] = doc;
      moves.value = plan.remaining;
      updated.forEach(doc => {
        documents[doc.ref.key] = doc;
      });
      history.value = [];
      future.value = [];
      saveOrder.value = saveOrder.value.filter(key => !updated.some(d => d.ref.key === key));
      clearSelection();
      error.value = '';
      notice.value = updated.some(d => d.ref.live) ? '已保存；使用中版本已应用'
        : updated.length ? '已保存' : '没有需要写入的改动';
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      busy.value = false;
    }
  }
  async function discard() {
    for (const doc of dirty.value) documents[doc.ref.key] = makeDocument(doc.ref, await host.load(doc.ref));
    history.value = [];
    future.value = [];
    saveOrder.value = [];
    moves.value = [];
    clearSelection();
    error.value = '';
    notice.value = '已放弃修改';
  }
  async function reload(doc: WorkDocument) {
    busy.value = true;
    try {
      const next = makeDocument(doc.ref, await host.load(doc.ref));
      const plan = planSave([doc.ref.key]);
      for (const [key, restored] of plan.restored) documents[key] = restored;
      moves.value = plan.remaining;
      documents[doc.ref.key] = next;
      history.value = [];
      future.value = [];
      clearSelection();
    } finally { busy.value = false; }
  }
  return {
    preferences,
    documents,
    keys,
    kind,
    resources,
    selected,
    clearSelection,
    anchor,
    operation,
    transferAction,
    activePage,
    busy,
    error,
    notice,
    history,
    future,
    dirty,
    docs,
    init,
    load,
    switchKind,
    ensureView,
    change,
    undo,
    redo,
    transfer,
    transferMany,
    save,
    planSave,
    checkSaveOnly,
    discard,
    reload,
  };
});
