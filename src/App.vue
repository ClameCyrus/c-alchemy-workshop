<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import {
  assignGroup,
  clone,
  entryFrom,
  groupOf,
  makeDocument,
  matchEntries,
  normalizeGroups,
  protectedEntry,
  rangeMembers,
  rawEntry,
  removeEntries,
  settingsOf,
  stable,
  uid,
} from './core';
import { useWorkbench } from './workbench';
import { applyAppearance } from './preferences';
import { useComparison } from './comparison';
import TextCompare from './TextCompare.vue';
import { browseRows } from './browse-rows';
import { installEntryDrag } from './entry-drag';
import { summarizeChanges, reviewSignature } from './change-summary';
import { VERSION } from './version';
import MaterialLibrary from './MaterialLibrary.vue';
import { collectMaterial, type Material } from './library';
import type { ChangeSummary } from './change-summary';
import type { Entry, Host, Match, OpenRequest, Provider, Side, WorkDocument } from './types';

const props = defineProps<{ host: Host }>();
const state = useWorkbench();
state.init(props.host);
const {
  docs,
  keys,
  resources,
  kind,
  dirty,
  operation,
  transferAction,
  activePage,
  anchor,
  selected,
  busy,
  error,
  notice,
} = storeToRefs(state);
const view = computed(() => state.preferences.views[kind.value]);
const opened = ref(false), appearanceDialog = ref(false), threshold = ref(0.5);
const panel = ref<HTMLDialogElement>();
watch(opened, async value => {
  if (!value) return;
  await nextTick();
  if (opened.value && panel.value && !panel.value.open) panel.value.showModal();
}, { flush: 'post' });
const dual = computed({ get: () => view.value.dual, set: value => { view.value.dual = value; } });
const filter = computed({ get: () => view.value.filter, set: value => { view.value.filter = value; } });
const relationFilter = computed({ get: () => view.value.relation, set: value => { view.value.relation = value; } });
const search = computed(() => view.value.search);
const includeUnused = computed({ get: () => view.value.unused, set: value => { view.value.unused = value; } });
const groupFilter = computed(() => view.value.groups);
watch(() => state.preferences.appearance, applyAppearance, { deep: true, immediate: true });
const searchQuery = ref<Record<Side, string>>({ ...search.value });
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => ({ ...search.value }), value => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { searchQuery.value = value; }, 120);
});
const rangeStart = ref<{ key: string; id: string } | null>(null);
const transferSource = ref<string>('');
const explicitSources = ref<string[]>([]);
const sourceSelections = computed(() =>
  Object.entries(selected.value)
    .filter(([key, ids]) => ids.length && state.documents[key]?.ref.kind === kind.value && [keys.value.left, keys.value.right, ...explicitSources.value].includes(key))
    .map(([key, ids]) => ({ key, ids: ids.filter(id => [...state.documents[key].entries, ...state.documents[key].unused].some(e => e.id === id && !protectedEntry(e))) }))
    .filter(s => s.ids.length),
);
const sourceIds = computed(() => sourceSelections.value.flatMap(s => s.ids));
const edit = ref<{ docKey: string; value: Entry } | null>(null);
const pendingNew = ref<string | null>(null);
const groupDialog = ref<string | null>(null);
const chosenProvider = ref('own'),
  clearProviders = ref<Provider[]>([]),
  syncProviders = ref<Provider[]>([]);
const confirmBox = ref<{
  title: string;
  message: string;
  destructive: boolean;
  changes?: ChangeSummary[];
  text?: string;
  value?: string;
  resolve: (value: string | boolean | null) => void;
} | null>(null);
const menu = ref<{ key: string; id: string } | null>(null);
const materialOpen = ref(false), materialCapture = ref<Material>(), materialTarget = ref(''), materialBody = ref(false);
let materialCaret: { id: string; docKey: string; start: number; end: number; content: string } | undefined;
const materialDocuments = computed(() => Object.values(state.documents));
async function loadMaterialTarget(key: string) {
  const ref = [...props.host.resources('preset'), ...props.host.resources('regex')].find(r => r.key === key);
  if (!ref) throw new Error('目标已不存在，请重新打开素材库');
  const old = state.documents[key];
  if (old?.dirty) {
    if (old.ref.name !== ref.name || old.ref.avatar !== ref.avatar) throw new Error('目标已切换，请先处理旧草稿');
    return;
  }
  const snapshot = await props.host.load(ref);
  if (!state.documents[key]?.dirty) state.documents[key] = makeDocument(ref, snapshot);
}
function openMaterials(doc?: WorkDocument, ids?: string[], body = false) {
  try {
    materialCapture.value = doc && ids ? collectMaterial(doc, ids) : undefined;
    state.clearSelection(); explicitSources.value = []; transferSource.value = ''; finishDrag();
    materialTarget.value = doc?.ref.key || docs.value[activePage.value]?.ref.key || keys.value.left;
    materialBody.value = body;
    if (body && edit.value) {
      const area = document.querySelector<HTMLTextAreaElement>('#prw-entry-content');
      materialCaret = { id: edit.value.value.id, docKey: edit.value.docKey, content: edit.value.value.content,
        start: area?.selectionStart ?? edit.value.value.content.length, end: area?.selectionEnd ?? edit.value.value.content.length };
    }
    menu.value = null; materialOpen.value = true;
  } catch (e) { error.value = (e as Error).message; }
}
function collectEdit() {
  if (!edit.value || !editDocument.value) return;
  const doc = clone(editDocument.value), entry = clone(edit.value.value);
  const area = document.querySelector<HTMLTextAreaElement>('#prw-entry-content');
  if (area && area.selectionEnd > area.selectionStart) entry.content = entry.content.slice(area.selectionStart, area.selectionEnd);
  doc.entries = [entry]; doc.unused = [];
  openMaterials(doc, [entry.id]);
}
async function applyMaterials(key: string, baseline: string, next: WorkDocument) {
  if (!state.documents[key] || stable(state.documents[key]) !== baseline) { error.value = '目标草稿已变化，请重新预览'; return; }
  state.change(() => { state.documents[key] = clone(next); });
  if (!state.error) {
    state.clearSelection(); explicitSources.value = []; transferSource.value = ''; finishDrag();
    materialOpen.value = false; clearComparison();
    if (kind.value !== next.ref.kind) await state.switchKind(next.ref.kind);
    resources.value = props.host.resources(kind.value);
    if (![keys.value.left, keys.value.right].includes(key)) await state.load(activePage.value, key);
    notice.value = '已加入草稿';
  }
}
function insertMaterialText(text: string) {
  const caret = materialCaret;
  if (!edit.value || !caret || edit.value.value.id !== caret.id || edit.value.docKey !== caret.docKey || edit.value.value.content !== caret.content) {
    error.value = '编辑目标已变化，请重新打开素材库'; return;
  }
  edit.value.value.content = caret.content.slice(0, caret.start) + text + caret.content.slice(caret.end);
  materialOpen.value = false;
}
const picked = ref<Record<Side, string>>({ left: '', right: '' });
const readerOpen = ref(false), readerPage = ref<Side>('left');
const pickedEntries = computed(() => Object.fromEntries((['left', 'right'] as Side[]).map(side =>
  [side, [...(docs.value[side]?.entries || []), ...(docs.value[side]?.unused || [])].find(e => e.id === picked.value[side])],
)) as Record<Side, Entry | undefined>);
function clearComparison() {
  anchor.value = null; picked.value = { left: '', right: '' }; readerOpen.value = false;
}
const savedScroll: Record<string, number> = {};
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const sideNames = computed(() => ({
  left: docs.value.left?.ref.label || '选择预设',
  right: docs.value.right?.ref.label || '选择预设',
}));
const anchorDoc = computed(() => (anchor.value && [keys.value.left, keys.value.right].includes(anchor.value.key) ? state.documents[anchor.value.key] : undefined));
const anchorEntry = computed(
  () => anchorDoc.value && [...anchorDoc.value.entries, ...anchorDoc.value.unused].find(e => e.id === anchor.value?.id),
);
const otherDoc = (doc: WorkDocument) => (doc.ref.key === keys.value.left ? docs.value.right : docs.value.left);
const matchCache = new Map<string, Match | null>();
const searchCache = new WeakMap<Entry, { name: string; content: string; text: string }>();
function searchable(entry: Entry) {
  const old = searchCache.get(entry);
  if (old?.name === entry.name && old.content === entry.content) return old.text;
  const text = `${entry.name}\n${entry.content}`.toLowerCase();
  searchCache.set(entry, { name: entry.name, content: entry.content, text });
  return text;
}
const signatureCache = new WeakMap<
  Entry,
  { content: string; name: string; enabled: boolean; role: string; raw: object; signature: string }
>();
function signature(entry: Entry) {
  const old = signatureCache.get(entry);
  if (
    old &&
    old.content === entry.content &&
    old.name === entry.name &&
    old.enabled === entry.enabled &&
    old.role === entry.role &&
    old.raw === entry.raw
  )
    return old.signature;
  const settings = stable(settingsOf(entry));
  let hash = 2166136261,
    second = 5381;
  for (let i = 0; i < entry.content.length; i++) {
    hash = Math.imul(hash ^ entry.content.charCodeAt(i), 16777619);
    second = Math.imul(second, 33) ^ entry.content.charCodeAt(i);
  }
  const value = `${entry.id}/${entry.name}/${entry.content.length}/${hash >>> 0}/${second >>> 0}/${settings}`;
  signatureCache.set(entry, {
    content: entry.content,
    name: entry.name,
    enabled: entry.enabled,
    role: entry.role,
    raw: entry.raw,
    signature: value,
  });
  return value;
}
function compare(a: Entry, b: Entry) {
  const key = `${signature(a)}\0${signature(b)}\0${threshold.value}`;
  if (matchCache.has(key)) return matchCache.get(key)!;
  if (matchCache.size > 20000) matchCache.clear();
  const result = matchEntries(a, b, threshold.value);
  matchCache.set(key, result);
  return result;
}
const { relations, exact, related, working: comparing } = useComparison(() => ({
  left: docs.value.left, right: docs.value.right, anchor: dual.value ? anchorEntry.value : undefined,
  anchorKey: anchor.value?.key, unused: includeUnused.value, filter: filter.value,
  enabled: opened.value && dual.value, threshold: threshold.value,
}), signature, compare);
const counts = computed(() => {
  const matches = [...relations.value.values()];
  return {
    total: matches.length,
    exact: matches.filter(m => m.type === 'exact').length,
    partial: matches.filter(m => m.type === 'partial').length,
    similar: matches.filter(m => m.type === 'similar').length,
  };
});
function matchFor(doc: WorkDocument, entry: Entry) {
  return anchor.value && anchor.value.key !== doc.ref.key ? relations.value.get(entry.id) : undefined;
}
const lists = computed(() => {
  const output: Record<Side, Entry[]> = { left: [], right: [] };
  for (const side of ['left', 'right'] as Side[]) {
    const doc = docs.value[side];
    if (!doc) continue;
    let list = [...doc.entries, ...(includeUnused.value ? doc.unused : [])];
    const other = otherDoc(doc),
      query = searchQuery.value[side].trim().toLowerCase();
    if ((filter.value === 'only-left' && side === 'right') || (filter.value === 'only-right' && side === 'left'))
      list = [];
    list = list.filter(entry => {
      if (query && !searchable(entry).includes(query)) return false;
      const group = groupOf(doc, entry.id);
      if (
        state.preferences.grouping && groupFilter.value[side] &&
        (groupFilter.value[side] === '__ungrouped' || doc.state.groups.some(g => g.id === groupFilter.value[side])) &&
        (groupFilter.value[side] === '__ungrouped' ? !!group : group?.id !== groupFilter.value[side])
      )
        return false;
      if (filter.value === 'disabled' && entry.enabled) return false;
      if (other && ['exact', 'different', 'only-left', 'only-right'].includes(filter.value)) {
        const hasExact = exact.value[side].has(entry.id);
        if (comparing.value && filter.value !== 'exact') return false;
        if (filter.value.startsWith('only-') && related.value[side].has(entry.id)) return false;
        if (filter.value === 'exact' && !hasExact) return false;
        if (filter.value === 'different' && (hasExact || !related.value[side].has(entry.id))) return false;
      }
      if (anchorEntry.value && anchor.value?.key !== doc.ref.key && relationFilter.value !== 'off') {
        const match = relations.value.get(entry.id);
        if (!match || (relationFilter.value !== 'all' && match.type !== relationFilter.value)) return false;
      }
      return true;
    });
    if (anchorEntry.value && anchor.value?.key !== doc.ref.key && relationFilter.value !== 'off') {
      const rank = { exact: 3, partial: 2, similar: 1 };
      list.sort(
        (a, b) =>
          rank[relations.value.get(b.id)!.type] - rank[relations.value.get(a.id)!.type] ||
          relations.value.get(b.id)!.score - relations.value.get(a.id)!.score,
      );
    }
    output[side] = list;
  }
  return output;
});
function foldKey(doc: WorkDocument, id: string) { return `${doc.ref.key}/${id}`; }
function toggleGroup(doc: WorkDocument, id: string) {
  const key = foldKey(doc, id);
  view.value.folds[key] = !view.value.folds[key];
}
const displayRows = computed(() => Object.fromEntries((['left', 'right'] as Side[]).map(side => {
  const doc = docs.value[side];
  return [side, doc ? browseRows(lists.value[side], state.preferences.grouping ? doc.state.groups : [],
    id => !!view.value.folds[foldKey(doc, id)],
    !!searchQuery.value[side].trim() || !!rangeStart.value || !!(anchor.value && anchor.value.key !== doc.ref.key && relationFilter.value !== 'off'),
  ) : []];
})) as Record<Side, ReturnType<typeof browseRows>>);
async function confirmSave(onlyKey?: string) {
  const documents = state.dirty.filter(d => !onlyKey || d.ref.key === onlyKey);
  if (!documents.length || busy.value || confirmBox.value) return false;
  const reviewed = reviewSignature(documents);
  const ok = await new Promise<boolean>(resolve => {
    confirmBox.value = { title: '确认保存', message: '', destructive: false,
      changes: documents.map(summarizeChanges), resolve: value => resolve(value === true) };
  });
  if (!ok) return false;
  if (reviewed !== reviewSignature(state.dirty.filter(d => !onlyKey || d.ref.key === onlyKey))) {
    error.value = '改动已变化，请重新确认保存'; return false;
  }
  return state.save(onlyKey);
}
function ask(title: string, message: string, destructive = false): Promise<boolean> {
  return new Promise(resolve => {
    confirmBox.value = { title, message, destructive, resolve: value => resolve(value === true) };
  });
}
function input(title: string, value = ''): Promise<string | null> {
  return new Promise(resolve => {
    confirmBox.value = {
      title,
      message: '',
      destructive: false,
      text: '名称',
      value,
      resolve: value => resolve(typeof value === 'string' ? value : null),
    };
  });
}
function finishConfirm(ok: boolean) {
  const box = confirmBox.value;
  confirmBox.value = null;
  box?.resolve(ok ? (box.text ? box.value?.trim() || null : true) : null);
}
async function open(request: OpenRequest = {}) {
  try {
    opened.value = true;
    if (request.kind && request.kind !== kind.value) await state.switchKind(request.kind);
    else resources.value = props.host.resources(kind.value);
    await state.ensureView(true);
    if (request.refKey) await state.load('left', request.refKey);
    else if (!docs.value.left && resources.value[0]) await state.load('left', resources.value[0].key);
    const doc = docs.value.left;
    if (doc && request.entryId) {
      const entry = [...doc.entries, ...doc.unused].find(e => e.id === request.entryId);
      if (entry) {
        if (!request.action) anchor.value = { key: doc.ref.key, id: entry.id };
        else clearComparison();
        if (request.action === 'edit') edit.value = { docKey: doc.ref.key, value: clone(entry) };
        if (request.action === 'group') rangeStart.value = { key: doc.ref.key, id: entry.id };
        if (request.action === 'collect') openMaterials(doc, request.ids || [entry.id]);
        if (request.action === 'delete' || request.action === 'detach')
          await erase(doc, [entry.id], request.action === 'detach');
      }
    }
    if (doc && ['copy', 'move'].includes(request.action || '')) {
      explicitSources.value = request.sources?.map(s => s.refKey) || [];
      for (const key of Object.keys(selected.value))
        if (state.documents[key]?.ref.kind === kind.value) selected.value[key] = [];
      if (request.sources?.length) {
        for (const source of request.sources) {
          const ref = resources.value.find(r => r.key === source.refKey);
          if (!ref) continue;
          if (!state.documents[ref.key] || !state.documents[ref.key].dirty)
            state.documents[ref.key] = makeDocument(ref, await props.host.load(ref));
          selected.value[ref.key] = [...source.ids];
        }
      }
      selected.value[doc.ref.key] = request.ids || (request.entryId ? [request.entryId] : []);
      transferSource.value = doc.ref.key;
      transferAction.value = request.action as 'copy' | 'move';
      operation.value = 'insert';
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
defineExpose({ open });
function close() {
  if (edit.value || confirmBox.value || groupDialog.value || appearanceDialog.value || materialOpen.value) return;
  opened.value = false;
  state.clearSelection(); explicitSources.value = []; transferSource.value = '';
  readerOpen.value = false;
  finishDrag();
  menu.value = null;
}
async function pick(side: Side, key: string) {
  clearComparison(); notice.value = ''; menu.value = null; rangeStart.value = null;
  await state.load(side, key);
  await nextTick();
  restoreScroll(side);
}
async function reload(doc: WorkDocument) {
  if (doc.dirty && !(await ask('重新载入', `${doc.ref.label}\n放弃这份未保存修改？`, true))) return;
  try {
    clearComparison();
    state.documents[doc.ref.key] = makeDocument(doc.ref, await props.host.load(doc.ref));
    state.history = [];
    state.future = [];
    selected.value[doc.ref.key] = [];
    error.value = '';
    notice.value = '已重新载入';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
function restoreScroll(side: Side) {
  const el = document.querySelector<HTMLElement>(`#prw-panel [data-list="${side}"]`);
  if (el) el.scrollTop = savedScroll[keys.value[side]] || 0;
}
function page(side: Side) {
  activePage.value = side;
  nextTick(() => restoreScroll(side));
}
function toggleSelect(doc: WorkDocument, id: string, checked: boolean) {
  if (checked && kind.value === 'preset') for (const key of Object.keys(selected.value)) if (key !== doc.ref.key) delete selected.value[key];
  explicitSources.value = [];
  const set = new Set(selected.value[doc.ref.key] || []);
  checked ? set.add(id) : set.delete(id);
  selected.value[doc.ref.key] = [...set];
  if (checked) transferSource.value = doc.ref.key;
}
function allSelect(side: Side) {
  const doc = docs.value[side];
  if (!doc) return;
  if (kind.value === 'preset') for (const key of Object.keys(selected.value)) if (key !== doc.ref.key) delete selected.value[key];
  explicitSources.value = [];
  const ids = lists.value[side].filter(e => !protectedEntry(e)).map(e => e.id),
    old = new Set(selected.value[doc.ref.key] || []);
  const all = ids.length > 0 && ids.every(id => old.has(id));
  ids.forEach(id => (all ? old.delete(id) : old.add(id)));
  selected.value[doc.ref.key] = [...old];
  transferSource.value = doc.ref.key;
}
async function selectEntry(doc: WorkDocument, entry: Entry, side: Side) {
  if (edit.value || materialOpen.value || groupDialog.value || appearanceDialog.value || confirmBox.value) return;
  if (window.getSelection()?.type === 'Range' && window.getSelection()?.toString().trim()) return;
  if (rangeStart.value) {
    if (rangeStart.value.key !== doc.ref.key) {
      notice.value = '在同一份列表里选终点';
      return;
    }
    const ids = rangeMembers(doc, rangeStart.value.id, entry.id);
    const hidden = ids.filter(id => !lists.value[side].some(e => e.id === id)).length;
    const overlap = ids.some(id => groupOf(doc, id));
    if (
      (hidden || overlap) &&
      !(await ask(
        '建立分组',
        `${ids.length} 条${hidden ? `，其中 ${hidden} 条未显示` : ''}${overlap ? '；已有分组中的条目会移入新组' : ''}。继续？`,
      ))
    )
      return;
    const name = await input(`分组 · ${ids.length} 条`);
    if (!name) return;
    state.change(() => {
      const id = uid();
      doc.state.native = true;
      doc.state.groups.push({ id, name, members: [], collapsed: false, enabled: true });
      assignGroup(doc, ids, id);
    });
    rangeStart.value = null;
    notice.value = '已分组';
    return;
  }
  if (dual.value && anchor.value?.key === doc.ref.key && anchor.value.id === entry.id) {
    clearComparison(); return;
  }
  const changingAnchor = anchor.value?.key === doc.ref.key && anchor.value.id !== entry.id;
  if (changingAnchor) { picked.value = { left: '', right: '' }; readerOpen.value = false; relationFilter.value = 'all'; }
  picked.value[side] = entry.id;
  readerPage.value = side;
  readerOpen.value = !dual.value || !!(pickedEntries.value.left && pickedEntries.value.right);
  if (!anchor.value || anchor.value.key === doc.ref.key) anchor.value = { key: doc.ref.key, id: entry.id };
}
async function erase(doc: WorkDocument, ids: string[], detach = false) {
  menu.value = null;
  const entries = [...doc.entries, ...doc.unused].filter(e => ids.includes(e.id));
  if (entries.some(protectedEntry)) {
    error.value = '系统或占位条目不能移除或删除';
    return;
  }
  if (
    !detach &&
    !(await ask(
      '删除条目',
      `${doc.ref.label}\n${entries.length === 1 ? entries[0]?.name : `${entries.length} 条`}\n保存后将删除。`,
      true,
    ))
  )
    return;
  state.change(() => removeEntries(doc, ids, detach));
  selected.value[doc.ref.key] = [];
  notice.value = detach ? '已移出列表' : '已加入待删除';
}
function beginTransfer(doc: WorkDocument, entry: Entry, action: 'copy' | 'move') {
  const ids = (selected.value[doc.ref.key] || []).includes(entry.id)
    ? selected.value[doc.ref.key]
    : [entry.id];
  state.clearSelection(); explicitSources.value = []; selected.value[doc.ref.key] = ids;
  transferSource.value = doc.ref.key;
  transferAction.value = action;
  operation.value = 'insert';
  menu.value = null;
}
const comparingSelection = computed(() => dual.value && !!anchorEntry.value);
function insertionPosition(doc: WorkDocument, id?: string, after = false, groupId?: string) {
  if (state.preferences.grouping) {
    if (groupId && !id) {
      id = doc.entries.filter(e => groupOf(doc, e.id)?.id === groupId).at(-1)?.id;
      after = !!id;
    }
    groupId ??= id ? groupOf(doc, id)?.id || '' : '';
  }
  return { key: doc.ref.key, id, after, groupId };
}
function insert(doc: WorkDocument, id?: string, after = false, groupId?: string) {
  if (!sourceIds.value.length) { notice.value = '先勾选来源条目'; return; }
  const position = insertionPosition(doc, id, after, groupId);
  state.transferMany(sourceSelections.value.map(s => ({ key: s.key, ids: [...s.ids] })),
    doc.ref.key, position.id, position.after, position.groupId);
}
const dragSource = ref<{ key: string; ids: string[] }[] | null>(null);
const dropTarget = ref<{ key: string; id?: string; after: boolean; groupId?: string; header?: string } | null>(null);
const entryDrag = installEntryDrag(() => panel.value, {
  start(row) {
    if (operation.value !== 'insert' || rangeStart.value || readerOpen.value || edit.value || materialOpen.value || groupDialog.value || appearanceDialog.value || confirmBox.value) return;
    const side = row.closest<HTMLElement>('[data-list]')?.dataset.list as Side;
    const doc = docs.value[side], entry = doc?.entries.find(e => e.id === row.dataset.entryId)
      || doc?.unused.find(e => e.id === row.dataset.entryId);
    if (!doc || !entry || protectedEntry(entry)) return;
    dragSource.value = [{ key: doc.ref.key, ids: (selected.value[doc.ref.key] || []).includes(entry.id)
      ? selected.value[doc.ref.key].filter(id => [...doc.entries, ...doc.unused].some(e => e.id === id && !protectedEntry(e))) : [entry.id] }];
    menu.value = null;
    const count = dragSource.value.reduce((sum, s) => sum + s.ids.length, 0);
    return `${entry.name}${count > 1 ? ` · ${count} 条` : ''}`;
  },
  over(element, y) {
    const list = element?.closest<HTMLElement>('.entry-list'), side = list?.dataset.list as Side;
    const doc = docs.value[side];
    dropTarget.value = null;
    if (!doc || !list || !dragSource.value) return;
    const row = element?.closest<HTMLElement>('.entry,.browse-group');
    if (row?.classList.contains('entry')) {
      const bounds = row.getBoundingClientRect();
      dropTarget.value = insertionPosition(doc, row.dataset.entryId, y >= bounds.top + bounds.height / 2);
    } else if (row?.dataset.groupId) {
      dropTarget.value = { ...insertionPosition(doc, undefined, false, row.dataset.groupId), header: row.dataset.groupId };
    } else if (!comparingSelection.value && !searchQuery.value[side].trim() && !groupFilter.value[side] && filter.value === 'all') {
      dropTarget.value = insertionPosition(doc);
    }
  },
  drop() {
    const position = dropTarget.value;
    if (!position || !dragSource.value) return;
    state.transferMany(dragSource.value, position.key, position.id, position.after, position.groupId);
  },
  end() { dragSource.value = null; dropTarget.value = null; },
});
function finishDrag() { entryDrag.cancel(); }
function saveEdit() {
  if (!edit.value) return;
  const { docKey, value } = edit.value,
    doc = state.documents[docKey];
  const original = [...doc.entries, ...doc.unused].find(e => e.id === value.id);
  if (!original) {
    if (!pendingNew.value || pendingNew.value !== value.id) {
      error.value = '条目已不存在';
      return;
    }
  }
  if (!value.name.trim()) return;
  state.change(() => {
    if (doc.ref.kind === 'regex') value.content = entryFrom(value.raw, 'regex').content;
    if (original) Object.assign(original, clone(value));
    else doc.entries.push(clone(value));
    doc.dirty = true;
  });
  edit.value = null;
  pendingNew.value = null;
}
let backdropPress: { element: EventTarget | null; x: number; y: number } | null = null;
function backdropDown(event: PointerEvent) {
  backdropPress = event.target === event.currentTarget ? { element: event.currentTarget, x: event.clientX, y: event.clientY } : null;
}
function backdropClose(event: MouseEvent, closeDialog: () => void) {
  const press = backdropPress; backdropPress = null;
  if (press?.element === event.currentTarget && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5) closeDialog();
}
async function createEntry(doc: WorkDocument) {
  const name = await input(doc.ref.kind === 'regex' ? '新正则' : '新条目');
  if (!name) return;
  const raw =
    doc.ref.kind === 'regex'
      ? {
          id: uid(),
          scriptName: name,
          findRegex: '',
          replaceString: '',
          disabled: true,
          runOnEdit: true,
          placement: [2],
          trimStrings: [],
          substituteRegex: 0,
          markdownOnly: true,
          promptOnly: false,
          minDepth: null,
          maxDepth: null,
        }
      : {
          identifier: uid(),
          name,
          content: '',
          role: 'system',
          system_prompt: false,
          marker: false,
          injection_position: 0,
          injection_depth: 4,
          injection_order: 100,
        };
  const entry = entryFrom(raw, doc.ref.kind, false);
  pendingNew.value = entry.id;
  edit.value = { docKey: doc.ref.key, value: clone(entry) };
}
function openGroups(doc: WorkDocument) {
  error.value = '';
  doc.sources = [
    { provider: 'own', label: '工坊', groups: clone(doc.state.groups), raw: doc.snapshot.own },
    ...doc.sources.filter(s => s.provider !== 'own'),
  ];
  groupDialog.value = doc.ref.key;
  chosenProvider.value = 'own';
  clearProviders.value = [...doc.cleanup];
  syncProviders.value = [...doc.state.sync];
}
async function applyGroups() {
  const doc = state.documents[groupDialog.value!];
  if (!doc || state.busy) return;
  try { state.checkSaveOnly(doc.ref.key); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); return; }
  const selectedSource = doc.sources.find(s => s.provider === chosenProvider.value);
  const seen = new Set<string>(),
    overlapping = new Set<string>();
  selectedSource?.groups.forEach(g =>
    g.members.forEach(id => {
      if (seen.has(id)) overlapping.add(id);
      seen.add(id);
    }),
  );
  if (
    overlapping.size &&
    !(await ask('分组有重叠', `${overlapping.size} 条同时属于多个分组。采用后按第一个分组归属，继续？`))
  )
    return;
  if (
    clearProviders.value.length &&
    !(await ask(
      '清理分组记录',
      `${doc.ref.label}\n清理${clearProviders.value.map(p => (p === 'baibai' ? '柏宝箱' : '预设转移工具')).join('、')}的分组记录，条目保留。`,
      true,
    ))
  )
    return;
  state.change(() => {
    const source = doc.sources.find(s => s.provider === chosenProvider.value);
    if (doc.snapshot.legacyOwn) doc.legacyResolved = true;
    if (source)
      doc.state.groups = normalizeGroups(
        clone(source.groups),
        [...doc.entries, ...doc.unused].map(e => e.id),
      );
    doc.cleanup = [...clearProviders.value];
    doc.state.suppressed = [
      ...new Set([...doc.state.suppressed.filter(p => !syncProviders.value.includes(p)), ...clearProviders.value]),
    ];
    doc.state.sync = syncProviders.value.filter(p => !clearProviders.value.includes(p));
    doc.state.native = true;
    doc.dirty = true;
  });
  if (!state.error && await confirmSave(doc.ref.key)) groupDialog.value = null;
}
async function groupAction(doc: WorkDocument, id: string, action: 'rename' | 'remove') {
  const group = doc.state.groups.find(g => g.id === id);
  if (!group) return;
  if (action === 'rename') {
    const name = await input('分组名称', group.name);
    if (name)
      state.change(() => {
        group.name = name;
        doc.dirty = true;
      });
  } else if (await ask('解散分组', `${group.name}\n条目保留。`))
    state.change(() => {
      doc.state.groups = doc.state.groups.filter(g => g.id !== id);
      doc.dirty = true;
    });
}
function download(doc: WorkDocument, entries?: Entry[]) {
  const data = entries
    ? entries.map(e => rawEntry(e, doc.ref.kind))
    : { name: doc.ref.label, entries: doc.entries, unused: doc.unused, groups: doc.state };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${doc.ref.label.replace(/[<>:"/\\|?*]/g, '_')}${entries ? '-条目' : '-工坊备份'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const groupDocument = computed(() => (groupDialog.value ? state.documents[groupDialog.value] : undefined));
const editDocument = computed(() => (edit.value ? state.documents[edit.value.docKey] : undefined));
function editPicked(side: Side) {
  const entry = pickedEntries.value[side], doc = docs.value[side];
  if (entry && doc) { readerOpen.value = false; edit.value = { docKey: doc.ref.key, value: clone(entry) }; }
}
watch(() => [kind.value, keys.value.left, keys.value.right], () => {
  clearComparison(); finishDrag(); notice.value = ''; menu.value = null; rangeStart.value = null;
}, { flush: 'sync' });
watch(pickedEntries, entries => { if (readerOpen.value && (!entries.left || (dual.value && !entries.right))) readerOpen.value = false; });
watch(filter, value => {
  if (value === 'only-left' || value === 'only-right') {
    clearComparison();
    page(value === 'only-left' ? 'left' : 'right');
  }
});
watch(dual, value => {
  if (!value) {
    filter.value = 'all';
    clearComparison();
    activePage.value = 'left';
  }
});
watch(kind, () => {
  clearComparison();
  menu.value = null;
  clearTimeout(searchTimer);
  searchQuery.value = { ...search.value };
});
watch(() => state.preferences.grouping, enabled => { if (!enabled) { rangeStart.value = null; groupDialog.value = null; menu.value = null; } });
watch(operation, () => {
  finishDrag();
  rangeStart.value = null;
  menu.value = null;
});
watch(chosenProvider, value => {
  if (
    value !== 'own' && value !== 'legacy' &&
    !clearProviders.value.includes(value as Provider) &&
    !syncProviders.value.includes(value as Provider)
  )
    syncProviders.value.push(value as Provider);
});
watch(notice, () => {
  clearTimeout(noticeTimer);
  if (notice.value)
    noticeTimer = setTimeout(() => {
      notice.value = '';
    }, 2800);
});
function keydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (materialOpen.value) return;
  if (readerOpen.value) { readerOpen.value = false; return; }
  if (dragSource.value) { finishDrag(); return; }
  if (confirmBox.value) finishConfirm(false);
  else if (edit.value) edit.value = null;
  else if (groupDialog.value) groupDialog.value = null;
  else if (appearanceDialog.value) appearanceDialog.value = false;
  else if (menu.value) menu.value = null;
  else if (rangeStart.value) rangeStart.value = null;
  else close();
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value.length) {
    event.preventDefault();
    event.returnValue = '';
  }
}
window.addEventListener('keydown', keydown);
window.addEventListener('beforeunload', beforeUnload);
onBeforeUnmount(() => {
  entryDrag.destroy();
  window.removeEventListener('keydown', keydown);
  window.removeEventListener('beforeunload', beforeUnload);
  clearTimeout(noticeTimer);
  clearTimeout(searchTimer);
});
</script>

<template>
  <dialog v-if="opened" ref="panel" id="prw-panel" class="prw-overlay" aria-label="Cの炼金工坊" @click.self="close" @cancel.prevent="close" @keydown.esc.stop.prevent="keydown">
    <section class="prw-window">
      <header class="prw-header">
        <div class="brand">
          <i class="brand-icon fa-solid fa-flask" aria-hidden="true"></i><strong class="prw-brand-name">Cの炼金工坊</strong><small>{{ VERSION }}</small
          ><small v-if="host.demo" class="demo-badge">演示</small>
        </div>
        <div class="header-actions">
          <button aria-label="设置" title="设置" @click="appearanceDialog = true">◐</button>
          <button class="history-action" :disabled="!state.history.length || busy" aria-label="撤销" title="撤销" @click="state.undo">↶</button
          ><button class="history-action" :disabled="!state.future.length || busy" aria-label="重做" title="重做" @click="state.redo">↷</button
          ><button
            v-if="dirty.length"
            class="discard-action" :disabled="busy" title="放弃本次改动"
            @click="async () => { if (await ask('放弃修改', '放弃所有未保存修改？', true)) await state.discard(); }"
          >放弃</button>
          <button class="primary" :disabled="!dirty.length || busy" @click="confirmSave()">
            {{ busy ? '保存中…' : dirty.length ? `保存 · ${dirty.length}` : '已保存' }}</button
          ><button aria-label="关闭" title="关闭" @click="close">✕</button>
        </div>
      </header>
      <nav class="prw-toolbar">
        <div class="segmented">
          <button :class="{ active: kind === 'preset' }" @click="state.switchKind('preset')">预设</button
          ><button :class="{ active: kind === 'regex' }" @click="state.switchKind('regex')">正则</button>
        </div>
        <button :class="{ active: dual }" @click="dual = !dual">对比</button>
        <button @click="openMaterials()">素材库</button>
        <select v-model="operation" aria-label="操作模式">
          <option value="browse">浏览</option>
          <option value="insert">插入 / 拖动</option>
        </select>
        <select v-if="operation !== 'browse'" v-model="transferAction" aria-label="转移方式">
          <option value="copy">复制</option>
          <option value="move">移动</option>
        </select>
        <select v-model="filter" aria-label="筛选">
          <option value="all">全部</option>
          <option v-if="dual" value="exact">相同</option>
          <option v-if="dual" value="different">有差异</option>
          <option v-if="dual" value="only-left">仅 {{ sideNames.left }}</option>
          <option v-if="dual" value="only-right">仅 {{ sideNames.right }}</option>
          <option value="disabled">已关闭</option>
        </select>
        <label v-if="kind === 'preset'" class="compact-check"
          ><input v-model="includeUnused" type="checkbox" />未加入列表</label
        >
      </nav>
      <div v-if="error" class="error-banner" role="alert">
        <span>{{ error }}</span
        ><button aria-label="关闭提示" title="关闭提示" @click="error = ''">✕</button>
      </div>
      <div v-if="rangeStart" class="context-banner">
        <span>选择终点</span><button @click="rangeStart = null">取消</button>
      </div>
      <div v-else-if="anchorEntry && dual" class="context-banner comparison-banner">
        <span class="anchor-name" :title="anchorEntry.name">{{ anchorEntry.name }}</span>
        <div class="match-filters">
          <button :class="{ active: relationFilter === 'all' }" @click="relationFilter = 'all'">
            {{ comparing ? '对比中…' : `${counts.total} 个对应` }}</button
          ><button class="exact" :class="{ active: relationFilter === 'exact' }" @click="relationFilter = 'exact'">
            相同 {{ counts.exact }}</button
          ><button
            class="partial"
            :class="{ active: relationFilter === 'partial' }"
            @click="relationFilter = 'partial'"
          >
            部分 {{ counts.partial }}</button
          ><button
            class="similar"
            :class="{ active: relationFilter === 'similar' }"
            @click="relationFilter = 'similar'"
          >
            相似 {{ counts.similar }}</button
          ><button
            aria-label="清除对比基准"
            title="清除对比基准"
            @click="clearComparison"
          >
            ✕
          </button>
        </div>
      </div>
      <nav v-if="dual" class="mobile-pages">
        <button
          v-for="side in ['left', 'right'] as Side[]"
          :key="side"
          :class="{ active: activePage === side }"
          :title="sideNames[side]"
          @click="page(side)"
        >
          {{ sideNames[side] }}
        </button>
      </nav>
      <main class="prw-columns" :class="{ single: !dual }">
        <section
          v-for="side in (dual ? ['left', 'right'] : ['left']) as Side[]"
          :key="side"
          class="prw-column"
          :class="{ 'mobile-hidden': dual && activePage !== side }"
        >
          <div class="resource-bar">
            <select
              :value="keys[side]"
              :aria-label="side === 'left' ? '来源' : '目标'"
              @change="pick(side, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">选择{{ kind === 'regex' ? '范围' : '预设' }}</option>
              <option v-for="r in resources" :key="r.key" :value="r.key">{{ r.label }}</option></select
            ><button v-if="docs[side]" aria-label="重新载入" title="重新载入" @click="reload(docs[side])">↻</button
            ><button v-if="state.preferences.grouping && docs[side]" aria-label="分组方案" title="分组方案" @click="openGroups(docs[side])">▤</button
            ><button v-if="docs[side]" aria-label="导出备份" title="导出备份" @click="download(docs[side])">⇩</button>
          </div>
          <template v-if="docs[side]">
            <div class="search-bar">
              <input
                v-model="search[side]"
                type="search"
                placeholder="搜索名称或正文"
                :aria-label="`${sideNames[side]} 搜索`"
              /><select v-if="state.preferences.grouping && docs[side].state.groups.length" v-model="groupFilter[side]" aria-label="分组筛选">
                <option value="">所有分组</option>
                <option value="__ungrouped">未分组</option>
                <option v-for="g in docs[side].state.groups" :key="g.id" :value="g.id">{{ g.name }}</option>
              </select>
            </div>
            <div class="list-toolbar">
              <button @click="allSelect(side)">全选</button
              ><button v-if="selected[docs[side].ref.key]?.length" @click="openMaterials(docs[side], selected[docs[side].ref.key])">收藏</button
              ><small
                >{{ lists[side].length }} 条<span v-if="selected[docs[side].ref.key]?.length">
                  · 已选 {{ selected[docs[side].ref.key].length }}</span
                ></small
              ><span class="spacer"></span
              ><button v-if="selected[docs[side].ref.key]?.length" @click="selected[docs[side].ref.key] = []">
                取消选择</button
              ><button aria-label="添加条目" title="添加条目" @click="createEntry(docs[side])">＋</button>
            </div>
            <div v-if="state.preferences.grouping && ((!docs[side].snapshot.own && docs[side].sources.length) || (docs[side].snapshot.legacyOwn && !docs[side].legacyResolved))" class="group-notice">
              <button @click="openGroups(docs[side])">选择分组方案 · {{ docs[side].sources.length }}</button>
            </div>
            <div
              class="entry-list"
              :data-list="side"
              @scroll="savedScroll[keys[side]] = ($event.target as HTMLElement).scrollTop"
              :class="{'drop-end':dropTarget?.key === docs[side].ref.key && !dropTarget.id && !dropTarget.header}"
            >
              <template v-for="row in displayRows[side]" :key="row.key">
              <template v-if="row.type === 'group'">
                <div
                  v-for="g in [row.group]"
                  :key="g.id"
                  class="group-chip browse-group"
                  :data-group-id="g.id"
                  :class="{'drop-group':dropTarget?.key === docs[side].ref.key && dropTarget.header === g.id}"
                >
                  <button
                    :aria-label="`${row.collapsed ? '展开' : '折叠'} ${g.name}`"
                    :aria-expanded="!row.collapsed"
                    @click="toggleGroup(docs[side], g.id)"
                  >
                    {{ row.collapsed ? '▸' : '▾' }}</button
                  ><button
                    class="browse-group-name"
                    @click="toggleGroup(docs[side], g.id)"
                  >
                    {{ g.name }} <small>{{ row.count }}</small>
                  </button>
                  <button :aria-label="`${g.enabled ? '停用' : '启用'} ${g.name}`" :title="g.enabled ? '停用本组，保留条目开关' : '启用本组，保留条目开关'" @click="state.change(() => { g.enabled = !g.enabled; docs[side].state.native = true; docs[side].dirty = true; })">{{ g.enabled ? '停用' : '启用' }}</button>
                  <details>
                    <summary aria-label="分组操作">⋯</summary>
                    <div class="small-menu">
                      <button @click="groupAction(docs[side], g.id, 'rename')">改名</button
                      ><button v-if="operation === 'insert'" @click="insert(docs[side], undefined, false, g.id)">
                        插入此组</button
                      ><button @click="groupAction(docs[side], g.id, 'remove')">解散分组</button>
                    </div>
                  </details>
                </div>
              </template>
              <template v-else>
              <article
                v-for="entry in [row.entry]"
                :key="entry.id"
                class="entry"
                :class="[
                  {
                    'can-drag': operation === 'insert' && !rangeStart && !protectedEntry(entry),
                    'group-member': !!row.groupId,
                    'group-end': row.groupEnd,
                    selected: selected[docs[side].ref.key]?.includes(entry.id),
                    anchor: picked[side] === entry.id,
                    'drop-before': dropTarget?.key === docs[side].ref.key && dropTarget.id === entry.id && !dropTarget.header && !dropTarget.after,
                    'drop-after': dropTarget?.key === docs[side].ref.key && dropTarget.id === entry.id && !dropTarget.header && dropTarget.after,
                    disabled: !entry.enabled,
                    protected: protectedEntry(entry),
                  },
                  matchFor(docs[side], entry)?.type,
                ]"
                :data-entry-id="entry.id"
                :data-group-id="row.groupId"
                draggable="false"
                :title="protectedEntry(entry) ? '系统条目：不能复制、移动或删除' : undefined"
                  @click="selectEntry(docs[side], entry, side)"
              >
                <div class="entry-top">
                  <input
                    type="checkbox"
                    :checked="selected[docs[side].ref.key]?.includes(entry.id)"
                    :disabled="protectedEntry(entry)"
                    :aria-label="`选择 ${entry.name}`"
                    @click.stop
                    @change="toggleSelect(docs[side], entry.id, ($event.target as HTMLInputElement).checked)"
                  /><span
                    v-if="operation === 'insert' && !protectedEntry(entry)"
                    class="drag-handle"
                    title="长按拖动"
                    >⠿</span
                  ><strong :title="entry.name">{{ entry.name }}</strong
                  ><span v-if="protectedEntry(entry)" class="tag protected-tag" title="不能复制、移动或删除">系统</span
                  ><span v-if="entry.unused" class="tag">未加入</span
                  ><span v-if="matchFor(docs[side], entry)?.settingsDifferent" class="tag">设置不同</span
                  ><button
                    class="enabled-toggle"
                    :aria-label="entry.enabled ? '关闭条目' : '开启条目'"
                    :title="entry.enabled ? '关闭' : '开启'"
                    @click.stop="
                      state.change(() => {
                        entry.enabled = !entry.enabled;
                        docs[side].dirty = true;
                      })
                    "
                  >
                    {{ entry.enabled ? '●' : '○' }}</button
                  ><button
                    class="row-more"
                    :aria-label="`${entry.name} 更多`"
                    @click.stop="
                      menu =
                        menu?.key === docs[side].ref.key && menu.id === entry.id
                          ? null
                          : { key: docs[side].ref.key, id: entry.id }
                    "
                  >
                    ⋯
                  </button>
                </div>
                <p>{{ entry.content.slice(0, 150) || '—' }}</p>
                <div class="entry-meta">
                  <span>{{ groupOf(docs[side], entry.id)?.name || '' }}</span
                  ><span v-if="matchFor(docs[side], entry)"
                    >{{ Math.round(matchFor(docs[side], entry)!.score * 100) }}%</span
                  >
                </div>
                <div v-if="operation === 'insert' && sourceIds.length" class="insert-actions" @click.stop>
                  <button @click="insert(docs[side], entry.id)">前面</button
                  ><button @click="insert(docs[side], entry.id, true)">后面</button>
                </div>
                <div v-if="menu?.key === docs[side].ref.key && menu.id === entry.id" class="row-menu" @click.stop>
                  <button :disabled="protectedEntry(entry)" @click="openMaterials(docs[side], (selected[docs[side].ref.key] || []).includes(entry.id) ? selected[docs[side].ref.key] : [entry.id])">收藏到素材库</button>
                  <button
                    @click="
                      edit = { docKey: docs[side].ref.key, value: clone(entry) };
                      menu = null;
                    "
                  >
                    编辑</button
                  ><button :disabled="protectedEntry(entry)" @click="beginTransfer(docs[side], entry, 'copy')">
                    复制到…</button
                  ><button :disabled="protectedEntry(entry)" @click="beginTransfer(docs[side], entry, 'move')">
                    移动到…</button
                  ><button
                    v-if="state.preferences.grouping"
                    :disabled="entry.unused"
                    @click="
                      rangeStart = { key: docs[side].ref.key, id: entry.id };
                      menu = null;
                    "
                  >
                    从这里分组</button
                  ><select
                    v-if="state.preferences.grouping && docs[side].state.groups.length"
                    aria-label="加入分组"
                    :value="groupOf(docs[side], entry.id)?.id || ''"
                    @change="
                      state.change(() =>
                        assignGroup(docs[side], [entry.id], ($event.target as HTMLSelectElement).value || undefined),
                      );
                      menu = null;
                    "
                  >
                    <option value="">未分组</option>
                    <option v-for="g in docs[side].state.groups" :key="g.id" :value="g.id">{{ g.name }}</option></select
                  ><button
                    @click="
                      download(docs[side], [entry]);
                      menu = null;
                    "
                  >
                    导出</button
                  ><button
                    v-if="kind === 'preset' && !entry.unused"
                    :disabled="protectedEntry(entry)"
                    @click="erase(docs[side], [entry.id], true)"
                  >
                    从列表移除</button
                  ><button
                    v-if="entry.unused"
                    @click="
                      state.change(() => {
                        entry.unused = false;
                        docs[side].unused = docs[side].unused.filter(e => e.id !== entry.id);
                        docs[side].entries.push(entry);
                        docs[side].dirty = true;
                      });
                      menu = null;
                    "
                  >
                    加入列表</button
                  ><button class="danger" :disabled="protectedEntry(entry)" @click="erase(docs[side], [entry.id])">
                    删除…
                  </button>
                </div>
              </article>
              </template>
              </template>
              <div v-if="!lists[side].length" class="empty-state">{{ comparing ? '对比中…' : '没有找到条目' }}</div>
              <button
                v-if="operation === 'insert' && sourceIds.length && !comparingSelection"
                class="append-button"
                @click="insert(docs[side])"
              >
                插入末尾 · {{ sourceIds.length }} 条
              </button>
            </div>
          </template>
          <div v-else class="empty-state">选择后开始</div>
        </section>
      </main>
      <TextCompare v-if="readerOpen" :left="pickedEntries.left" :right="dual ? pickedEntries.right : undefined" :names="sideNames" :initial-page="readerPage" @close="readerOpen=false" @edit="editPicked" />
      <footer class="prw-footer">
        <small v-if="operation !== 'browse'"
          >插入 / 拖动 · {{ transferAction === 'copy' ? '复制' : '移动'
          }}<span v-if="sourceIds.length"> · {{ sourceIds.length }} 条</span></small
        ><small v-else>{{ dirty.length ? `${dirty.length} 份待保存` : '' }}</small
        ><span class="spacer"></span><small role="status">{{ notice }}</small>
        <div class="mobile-history">
          <button :disabled="!state.history.length || busy" aria-label="撤销" title="撤销" @click="state.undo">↶</button>
          <button :disabled="!state.future.length || busy" aria-label="重做" title="重做" @click="state.redo">↷</button>
        </div>
      </footer>
      <div v-if="edit && editDocument" class="dialog-shade" @pointerdown.capture="backdropDown" @click.self="backdropClose($event, () => edit = null)">
        <form class="edit-dialog" @submit.prevent="saveEdit">
          <header>
            <strong>{{ edit.value.name }}</strong
            ><button type="button" @click="edit = null">✕</button>
          </header>
          <label>名称<input v-model="edit.value.name" required /></label
          ><label class="compact-check"><input v-model="edit.value.enabled" type="checkbox" />启用</label
          ><template v-if="editDocument.ref.kind === 'preset'"
            ><div class="field-row">
              <label
                >角色<select v-model="edit.value.role">
                  <option value="system">系统</option>
                  <option value="user">用户</option>
                  <option value="assistant">AI</option>
                </select></label
              ><label
                >位置<select v-model="edit.value.raw.injection_position">
                  <option :value="0">相对</option>
                  <option :value="1">聊天中</option>
                </select></label
              ><label>深度<input v-model.number="edit.value.raw.injection_depth" type="number" min="0" /></label
              ><label>顺序<input v-model.number="edit.value.raw.injection_order" type="number" /></label>
            </div>
            <label
              >正文<textarea id="prw-entry-content"
                v-model="edit.value.content"
                rows="13"
                :readonly="!!edit.value.raw.marker"
              ></textarea></label></template
          ><template v-else
            ><label>查找<textarea v-model="edit.value.raw.findRegex" rows="3"></textarea></label
            ><label>替换<textarea v-model="edit.value.raw.replaceString" rows="8"></textarea></label>
            <div class="field-row">
              <label
                >最小深度<input
                  v-model.number="edit.value.raw.minDepth"
                  type="number"
                  @change="
                    edit.value.raw.minDepth = edit.value.raw.minDepth === '' ? null : edit.value.raw.minDepth
                  " /></label
              ><label
                >最大深度<input
                  v-model.number="edit.value.raw.maxDepth"
                  type="number"
                  @change="
                    edit.value.raw.maxDepth = edit.value.raw.maxDepth === '' ? null : edit.value.raw.maxDepth
                  " /></label
              ><label
                >替换宏<select v-model="edit.value.raw.substituteRegex">
                  <option :value="0">不替换</option>
                  <option :value="1">替换</option>
                  <option :value="2">转义替换</option>
                </select></label
              >
            </div>
            <div class="check-row">
              <label><input v-model="edit.value.raw.markdownOnly" type="checkbox" />仅显示</label
              ><label><input v-model="edit.value.raw.promptOnly" type="checkbox" />仅提示词</label
              ><label><input v-model="edit.value.raw.runOnEdit" type="checkbox" />编辑时运行</label>
            </div>
            <div class="check-row">
              <label
                v-for="item in [
                  [1, '用户'],
                  [2, 'AI'],
                  [3, '命令'],
                  [5, '世界书'],
                  [6, '推理'],
                ]"
                :key="String(item[0])"
                ><input v-model="edit.value.raw.placement" type="checkbox" :value="item[0]" />{{ item[1] }}</label
              >
            </div>
            <label
              >裁剪文本<textarea
                :value="(edit.value.raw.trimStrings || []).join('\n')"
                rows="2"
                @input="
                  edit.value.raw.trimStrings = ($event.target as HTMLTextAreaElement).value.split('\n').filter(Boolean)
                "
              ></textarea></label
          ></template>
          <footer>
            <template v-if="editDocument.ref.kind === 'preset' && !protectedEntry(edit.value)"><button type="button" @click="collectEdit">收藏选区／条目</button><button type="button" @click="openMaterials(editDocument, undefined, true)">插入素材</button></template>
            <button type="button" @click="edit = null">取消</button><button class="primary" type="submit">完成</button>
          </footer>
        </form>
      </div>
      <MaterialLibrary v-if="materialOpen" :host="host" :capture="materialCapture" :documents="materialDocuments" :target="materialTarget" :load-target="loadMaterialTarget" :body-mode="materialBody" :grouping="state.preferences.grouping" :folds="state.preferences.library.folds" @close="materialOpen = false" @apply="applyMaterials" @text="insertMaterialText" />
      <div v-if="groupDocument" class="dialog-shade" @pointerdown.capture="backdropDown" @click.self="backdropClose($event, () => groupDialog = null)">
        <section class="group-dialog">
          <header><strong>分组方案</strong><button @click="groupDialog = null">✕</button></header>
          <label v-if="!groupDocument.sources.some(s => s.provider === 'own')" class="source-option"
            ><input v-model="chosenProvider" type="radio" value="own" />工坊 · 空分组</label
          >
          <div v-for="source in groupDocument.sources" :key="source.provider" class="source-card">
            <label class="source-option"
              ><input v-model="chosenProvider" type="radio" :value="source.provider" />{{ source.label }}
              <small>{{ source.groups.length }} 组</small></label
            >
            <details v-for="g in source.groups" :key="g.id">
              <summary>
                {{ g.name }} <small>{{ g.members.length }}</small>
              </summary>
              <p>
                {{
                  g.members
                    .map(id => [...groupDocument!.entries, ...groupDocument!.unused].find(e => e.id === id)?.name || id)
                    .join('、')
                }}
              </p>
            </details>
            <label v-if="source.provider !== 'own'" class="compact-check danger"
              ><input v-model="clearProviders" type="checkbox" :value="source.provider" />清理这份记录</label
            >
          </div>
          <div class="sync-options">
            <span>写回</span
            ><label v-for="p in ['baibai', 'transfer'] as Provider[]" :key="p" class="compact-check"
              ><input v-model="syncProviders" :disabled="clearProviders.includes(p)" type="checkbox" :value="p" />{{
                p === 'baibai' ? '柏宝箱' : '预设转移工具'
              }}</label
            >
          </div>
          <footer>
            <span v-if="error" class="error" role="alert">{{ error }}</span>
            <button :disabled="state.busy" @click="groupDialog = null">取消</button><button class="primary" :disabled="state.busy" @click="applyGroups">{{ state.busy ? '保存中…' : '采用并保存' }}</button>
          </footer>
        </section>
      </div>
      <div v-if="appearanceDialog" class="dialog-shade" @pointerdown.capture="backdropDown" @click.self="backdropClose($event, () => appearanceDialog = false)">
        <section class="appearance-dialog">
          <header><strong>设置</strong><button aria-label="关闭外观" @click="appearanceDialog = false">✕</button></header>
          <label class="compact-check"><input v-model="state.preferences.grouping" type="checkbox" />启用分组功能</label>
          <label class="compact-check"><input v-model="state.preferences.presetLock" type="checkbox" />启用预设条目锁</label>
          <label class="compact-check"><input v-model="state.preferences.presetSwitch" type="checkbox" />优化预设切换并保护保存</label>
          <label class="compact-check"><input v-model="state.preferences.presetRefresh" type="checkbox" />优化原生条目刷新与拖动</label>
          <select v-model="state.preferences.appearance.mode" aria-label="配色方式">
            <option value="theme">跟随酒馆</option><option value="custom">自定义</option>
          </select>
          <div v-if="state.preferences.appearance.mode === 'custom'" class="palette-grid">
            <label v-for="item in [{key:'background',label:'背景'},{key:'text',label:'文字'},{key:'muted',label:'次要文字'},{key:'accent',label:'强调'},{key:'border',label:'边框'}] as const" :key="item.key">
              {{ item.label }}<input v-model="state.preferences.appearance[item.key]" type="color" :aria-label="item.label + '颜色'" />
            </label>
          </div>
        </section>
      </div>
      <div v-if="confirmBox" class="dialog-shade confirm-shade">
        <form
          class="confirm-dialog"
          role="alertdialog"
          :aria-label="confirmBox.title"
          @submit.prevent="finishConfirm(true)"
        >
          <header>
            <strong>{{ confirmBox.title }}</strong>
          </header>
          <p v-if="confirmBox.message">{{ confirmBox.message }}</p>
          <div v-if="confirmBox.changes" class="save-review">
            <section v-for="(change,i) in confirmBox.changes" :key="i">
              <strong>{{ change.name }} <small>{{ change.scope }}</small></strong>
              <ul><li v-for="(line,j) in change.lines" :key="j">{{ line }}</li></ul>
            </section>
          </div>
          <label v-if="confirmBox.text"
            >{{ confirmBox.text }}<input v-model="confirmBox.value" autofocus required
          /></label>
          <footer>
            <button type="button" @click="finishConfirm(false)">取消</button
            ><button :class="confirmBox.destructive ? 'destructive' : 'primary'" type="submit">确定</button>
          </footer>
        </form>
      </div>
    </section>
  </dialog>
</template>

<style scoped>
#prw-panel.prw-overlay {
  position: fixed;
  inset: 0;
  z-index: 100100;
  background: var(--prw-shade);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  color: var(--prw-text);
  font:
    14px/1.45 system-ui,
    -apple-system,
    'Microsoft YaHei',
    sans-serif;
  color-scheme: normal;
  box-sizing: border-box;
  overflow: hidden;
  max-width: 100vw;
  max-height: 100dvh;
}
.prw-overlay * {
  box-sizing: border-box;
}
.prw-window {
  contain: layout style;
  width: min(1440px, 100%);
  height: min(920px, calc(100dvh - 40px));
  background: var(--prw-bg);
  border: 1px solid var(--prw-border);
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 28px 100px var(--prw-shadow);
  overflow: hidden;
}
.prw-overlay button,
.prw-overlay select,
.prw-overlay input,
.prw-overlay textarea {
  font: inherit;
  color: inherit;
  border: 1px solid var(--prw-border);
  border-radius: 7px;
  background: var(--prw-surface);
  min-width: 0;
}
.prw-overlay button {
  cursor: pointer;
  margin: 0;
  padding: 6px 10px;
  line-height: 1.25;
}
.prw-overlay button:hover {
  background: var(--prw-hover);
}
.prw-overlay button:disabled {
  opacity: 0.35;
  cursor: default;
}
.prw-overlay input,
.prw-overlay select,
.prw-overlay textarea {
  padding: 7px 9px;
  margin: 0;
  line-height: 1.25;
}
.prw-overlay input[type='checkbox'],
.prw-overlay input[type='radio'] {
  accent-color: var(--prw-accent);
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  padding: 0;
}
.prw-overlay input:focus-visible,
.prw-overlay button:focus-visible,
.prw-overlay select:focus-visible,
.prw-overlay textarea:focus-visible {
  outline: 2px solid var(--prw-accent);
  outline-offset: 2px;
}
.prw-header,
.prw-toolbar,
.resource-bar,
.search-bar,
.list-toolbar,
.prw-footer,
.context-banner {
  display: flex;
  align-items: center;
  gap: 8px;
}
.prw-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--prw-border);
  justify-content: space-between;
}
.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  white-space: nowrap;
  min-width: 0;
}
.brand strong {
  font-size: 18px;
  letter-spacing: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.brand-icon {
  font-size: 23px;
  color: var(--prw-accent);
}
.brand small {
  color: var(--prw-muted);
  font-size: 11px;
}
.demo-badge {
  border: 1px solid var(--prw-border);
  padding: 1px 5px;
  border-radius: 4px;
}
.header-actions {
  display: flex;
  gap: 7px;
}
.header-actions button {
  white-space: nowrap;
}
.prw-overlay .primary {
  background: var(--prw-active);
  color: var(--prw-text);
  border-color: var(--prw-accent);
  font-weight: 650;
}
.prw-overlay .primary:hover {
  background: var(--prw-hover);
}
.prw-toolbar {
  padding: 10px 20px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--prw-border);
}
.segmented {
  display: flex;
  background: var(--prw-inset);
  border-radius: 8px;
  padding: 3px;
  gap: 2px;
}
.segmented button {
  border: 0;
  background: transparent;
}
.prw-overlay .active {
  background: var(--prw-active);
  border-color: var(--prw-accent);
  color: var(--prw-text);
}
.compact-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  white-space: nowrap;
}
.text-button {
  border-color: transparent !important;
  background: transparent !important;
}
.context-banner {
  min-height: 42px;
  padding: 7px 20px;
  background: var(--prw-active);
  justify-content: space-between;
  border-bottom: 1px solid var(--prw-border);
}
.anchor-name {
  max-width: 35%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--prw-accent);
}
.match-filters {
  display: flex;
  gap: 5px;
  align-items: center;
  flex-wrap: wrap;
}
.match-filters button {
  font-size: 12px;
  padding: 4px 7px;
  background: transparent;
}
.prw-overlay .exact {
  color: var(--prw-exact);
}
.prw-overlay .partial {
  color: var(--prw-partial);
}
.prw-overlay .similar {
  color: var(--prw-similar);
}
.prw-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.prw-columns.single {
  grid-template-columns: minmax(0, 1fr);
}
.prw-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.prw-column + .prw-column {
  border-left: 1px solid var(--prw-border);
}
.resource-bar {
  padding: 14px 16px 8px;
}
.resource-bar select {
  flex: 1;
  font-weight: 600;
  text-overflow: ellipsis;
}
.search-bar {
  padding: 0 16px 8px;
}
.search-bar input {
  flex: 1;
  width: 0;
  background: var(--prw-inset);
}
.search-bar select {
  max-width: 38%;
  font-size: 12px;
  background: var(--prw-inset);
}
.list-toolbar {
  padding: 0 16px 8px;
  color: var(--prw-muted);
}
.list-toolbar button {
  font-size: 12px;
  padding: 4px 7px;
  border: 0;
  background: transparent;
}
.spacer {
  flex: 1;
}
.entry-list {
  overflow: auto;
  overscroll-behavior: contain;
  min-height: 0;
  flex: 1;
  padding: 0 12px 16px;
  scrollbar-width: thin;
  scrollbar-color: var(--prw-border) transparent;
}
.entry {
  position: relative;
  background: var(--prw-surface);
  border: 1px solid var(--prw-border);
  border-left: 3px solid transparent;
  border-radius: 9px;
  margin: 7px 3px;
  padding: 10px 11px;
  cursor: pointer;
  color: var(--prw-text);
  transition: background 0.12s;
}
.entry:hover {
  background: var(--prw-hover);
}
.entry.exact {
  border-left-color: #79bf94;
}
.entry.partial {
  border-left-color: #d0b778;
}
.entry.similar {
  border-left-color: #829fce;
}
.entry.selected {
  background: var(--prw-active);
  border-color: var(--prw-border);
}
.entry.anchor {
  outline: 1px solid var(--prw-accent);
  background: var(--prw-active);
}
.entry.disabled .entry-top strong {
  opacity: 0.6;
}
.entry-top {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.entry-top strong {
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-size: 14px;
  color: var(--prw-text);
}
.entry-top button {
  padding: 2px 5px;
  background: transparent;
  border: 0;
  font-size: 18px;
}
.entry-top .enabled-toggle {
  font-size: 13px;
  color: var(--prw-accent);
}
.entry p {
  font-size: 12px;
  line-height: 1.6;
  max-height: 3.2em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  margin: 7px 0 3px;
  color: var(--prw-muted);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.entry-meta {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  line-height: 1.2;
  color: var(--prw-muted);
  min-height: 12px;
}
.tag {
  font-size: 10px;
  padding: 1px 4px;
  background: var(--prw-active);
  border-radius: 4px;
  white-space: nowrap;
}
.drag-handle {
  cursor: grab;
  color: var(--prw-accent);
  font-size: 19px;
}
.row-menu {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  border-top: 1px solid var(--prw-border);
  margin-top: 9px;
  padding-top: 9px;
}
.row-menu button,
.row-menu select {
  font-size: 12px;
  padding: 5px 8px;
}
.danger {
  color: var(--prw-danger) !important;
}
.insert-actions {
  display: flex;
  gap: 6px;
  margin-top: 7px;
}
.insert-actions button {
  font-size: 12px;
  padding: 4px 14px;
  border-style: dashed;
  background: var(--prw-active);
}
.group-notice {
  padding: 0 16px 5px;
}
.group-notice button {
  font-size: 12px;
  color: var(--prw-warning);
  background: transparent;
  border-color: #6b633e;
}
.group-chips {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  padding: 3px;
}
.group-chip {
  display: flex;
  align-items: center;
  border: 1px solid var(--prw-border);
  border-radius: 6px;
  position: relative;
}
.group-chip > button {
  border: 0;
  font-size: 12px;
  background: var(--prw-surface);
  padding: 4px 7px;
}
.group-chip small {
  color: var(--prw-muted);
  margin-left: 5px;
}
.group-chip summary {
  list-style: none;
  padding: 0 5px;
  cursor: pointer;
}
.small-menu {
  position: absolute;
  z-index: 3;
  top: 100%;
  right: 0;
  display: grid;
  min-width: 100px;
  background: var(--prw-surface);
  padding: 5px;
  border: 1px solid var(--prw-border);
  border-radius: 6px;
}
.small-menu button {
  font-size: 12px;
  text-align: left;
  border: 0;
}
.append-button {
  width: calc(100% - 6px);
  margin: 10px 3px;
  border-style: dashed !important;
}
.empty-state {
  display: grid;
  place-content: center;
  min-height: 130px;
  color: var(--prw-muted);
  font-size: 13px;
}
.prw-footer {
  padding: 8px 20px;
  border-top: 1px solid var(--prw-border);
  min-height: 36px;
  color: var(--prw-muted);
}
.detail-strip {
  max-height: 25%;
  background: var(--prw-inset);
  border-top: 1px solid var(--prw-border);
  display: flex;
  flex-direction: column;
  padding: 10px 20px;
}
.detail-strip > div {
  display: flex;
  align-items: center;
  gap: 8px;
}
.detail-strip strong {
  font-size: 12px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-strip button {
  font-size: 12px;
  padding: 3px 7px;
}
.detail-strip pre {
  font:
    12px/1.65 ui-monospace,
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: auto;
  margin: 7px 0;
  color: var(--prw-muted);
  max-height: 140px;
}
.detail-strip mark {
  color: inherit;
  background: var(--prw-hover);
}
.detail-strip mark.removed {
  background: color-mix(in srgb,var(--prw-bg) 82%,#c8493b 18%);
  text-decoration: line-through;
}
.error-banner {
  background: color-mix(in srgb,var(--prw-bg) 82%,#c8493b 18%);
  color: var(--prw-text);
  display: flex;
  gap: 10px;
  padding: 9px 20px;
  font-size: 12px;
}
.error-banner span {
  flex: 1;
  overflow-wrap: anywhere;
}
.error-banner button {
  background: transparent;
}
.mobile-pages {
  display: none;
}
.dialog-shade {
  position: absolute;
  inset: 0;
  z-index: 20;
  background: var(--prw-shade);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.prw-window {
  position: relative;
}
.edit-dialog,
.group-dialog,
.confirm-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--prw-surface);
  border: 1px solid var(--prw-border);
  border-radius: 12px;
  width: min(740px, 100%);
  max-height: 95%;
  overflow: auto;
  padding: 20px;
  box-shadow: 0 20px 70px var(--prw-shadow);
}
.edit-dialog header,
.group-dialog header,
.confirm-dialog header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.edit-dialog > label,
.confirm-dialog > label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--prw-muted);
}
.edit-dialog > label.compact-check {
  flex-direction: row;
}
.edit-dialog textarea {
  resize: vertical;
  min-height: 40px;
  font:
    13px/1.7 ui-monospace,
    monospace;
  white-space: pre-wrap;
}
.field-row,
.check-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.field-row label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 70px;
  font-size: 12px;
}
.check-row label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.edit-dialog footer,
.group-dialog footer,
.confirm-dialog footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.confirm-shade {
  z-index: 30;
}
.confirm-dialog {
  width: min(420px, 100%);
}
.confirm-dialog p {
  white-space: pre-line;
  color: var(--prw-text);
  overflow-wrap: anywhere;
}
.destructive {
  background: #a54f46 !important;
  color: white !important;
  border-color: #d18f84 !important;
}
.source-card {
  border: 1px solid var(--prw-border);
  border-radius: 8px;
  padding: 10px;
}
.source-option {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.source-card details {
  font-size: 12px;
  padding: 5px 0 0 24px;
  color: var(--prw-muted);
}
.source-card p {
  font-size: 11px;
  color: var(--prw-muted);
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.source-card .compact-check {
  margin: 8px 0 0 24px;
}
.sync-options {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--prw-muted);
}
.source-option small {
  color: var(--prw-muted);
}
.prw-overlay button,
.prw-overlay summary {
  -webkit-tap-highlight-color: transparent;
}
@media (max-width: 760px) {
  #prw-panel.prw-overlay {
    padding: 0;
    font-size: 13px;
  }
  #prw-panel .prw-window {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    flex: 1;
    height: 100dvh;
    max-height: 100dvh;
    border: 0;
    border-radius: 0;
  }
  .prw-header {
    padding: 8px 10px;
    flex-wrap: wrap;
    gap: 6px;
  }
  .header-actions { margin-left: auto; max-width: 100%; flex-wrap: wrap; }
  .brand { max-width: 100%; }
  .brand strong { min-width: 0; }

  .brand {
    gap: 6px;
  }
  .brand strong {
    font-size: 16px;
  }
  .brand small {
    font-size: 9px;
  }
  .header-actions {
    gap: 4px;
  }
  .header-actions button {
    padding: 6px 8px;
  }
  .prw-toolbar {
    padding: 7px 10px;
    gap: 6px;
  }
  .prw-toolbar > select {
    max-width: 100%;
    font-size: 12px;
  }
  .compact-check {
    font-size: 11px;
  }
  .context-banner {
    padding: 6px 10px;
    gap: 5px;
    align-items: flex-start;
    flex-direction: column;
  }
  .anchor-name {
    max-width: 100%;
    font-size: 12px;
  }
  .match-filters {
    gap: 4px;
    flex-wrap: nowrap;
    max-width: 100%;
    overflow-x: auto;
  }
  .match-filters button {
    font-size: 11px;
    white-space: nowrap;
    padding: 4px 6px;
  }
  .mobile-pages {
    display: flex;
    border-bottom: 1px solid var(--prw-border);
    padding: 5px 10px;
    gap: 6px;
  }
  .mobile-pages button {
    flex: 1;
    min-width: 0;
    max-width: 50%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 12px;
    padding: 7px;
  }
  .prw-columns {
    display: flex;
    min-height: 0;
  }
  .prw-column {
    flex: 1;
  }
  .prw-column + .prw-column {
    border: 0;
  }
  .mobile-hidden {
    display: none;
  }
  .resource-bar {
    padding: 9px 10px 7px;
    gap: 5px;
  }
  .resource-bar select {
    font-size: 12px;
  }
  .resource-bar button {
    padding: 6px 8px;
  }
  .search-bar {
    padding: 0 10px 6px;
    gap: 5px;
  }
  .search-bar input {
    font-size: 12px;
    padding: 7px;
  }
  .search-bar select {
    font-size: 11px;
    padding: 7px 5px;
  }
  .list-toolbar {
    padding: 0 10px 4px;
  }
  .entry-list {
    padding: 0 7px 12px;
  }
  .entry {
    margin: 6px 2px;
    padding: 9px;
  }
  .entry-top strong {
    font-size: 13px;
  }
  .entry-top {
    gap: 5px;
  }
  .entry p {
    font-size: 11px;
    margin-top: 5px;
  }
  .entry-meta {
    font-size: 9px;
  }
  .prw-footer {
    padding: 6px 10px;
    font-size: 11px;
  }
  .detail-strip {
    padding: 8px 10px;
    max-height: 22%;
  }
  .detail-strip pre {
    font-size: 11px;
    max-height: 85px;
  }
  .dialog-shade {
    padding: 8px;
  }
  .edit-dialog,
  .group-dialog,
  .confirm-dialog {
    padding: 14px;
    max-height: 97%;
    border-radius: 10px;
    gap: 10px;
  }
  .edit-dialog textarea {
    font-size: 12px;
  }
  .field-row {
    gap: 6px;
  }
  .field-row label {
    min-width: 60px;
  }
  .error-banner {
    padding: 7px 10px;
  }
  .group-notice {
    padding: 0 10px 4px;
  }
}
@media (max-width: 360px) {
  .brand small:not(.demo-badge) {
    display: none;
  }
  .brand strong {
    font-size: 15px;
  }
  .header-actions button {
    padding: 6px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .entry {
    transition: none;
  }
}


.appearance-dialog{width:min(340px,100%);padding:16px;background:var(--prw-bg);border:1px solid var(--prw-border);border-radius:12px;display:grid;gap:14px}.appearance-dialog header{display:flex;align-items:center;justify-content:space-between}.palette-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.palette-grid label{display:flex;align-items:center;justify-content:space-between;gap:8px}.palette-grid input[type=color]{width:38px;height:32px;padding:2px}
.mobile-history{display:none}
@media(max-width:420px){.header-actions .history-action{display:none}.mobile-history{display:flex;gap:4px}.mobile-history button{padding:3px 6px}.brand small{display:none}.header-actions button{padding:6px}.brand strong{flex-shrink:1}}

.entry.protected{border-inline-start-color:var(--prw-muted);border-inline-start-style:dashed}.protected-tag{color:var(--prw-muted);border:1px dashed var(--prw-border);background:transparent;flex:none}.entry.protected .drag-handle{display:none}
</style>

<style scoped>
.prw-toolbar>button,.prw-toolbar>select,.resource-bar>button,.resource-bar>select,.search-bar>input,.search-bar>select{height:36px;box-sizing:border-box;margin:0;align-self:center}
.prw-toolbar>.segmented{height:36px;box-sizing:border-box;align-items:stretch}.prw-toolbar>.segmented button{margin:0;display:flex;align-items:center}
.prw-toolbar>select{width:auto;max-width:min(360px,100%)}
.entry.can-drag{cursor:grab;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:pan-y}.entry.entry-dragging{cursor:grabbing;opacity:.6}.entry{position:relative}
.entry.drop-before::before,.entry.drop-after::after{content:'';position:absolute;left:0;right:0;height:4px;background:var(--prw-accent);border-radius:3px;box-shadow:0 0 0 1px var(--prw-bg);pointer-events:none;z-index:3}
.entry.drop-before::before{top:-6px}.entry.drop-after::after{bottom:-6px}.entry-list.drop-end{box-shadow:inset 0 -4px var(--prw-accent)}.group-chip.drop-group{outline:2px solid var(--prw-accent)}
</style>

<style scoped>
.entry.group-member{margin-inline-start:12px;box-shadow:inset 2px 0 color-mix(in srgb,var(--prw-accent) 30%,transparent)}
.entry.group-end{border-bottom:2px solid color-mix(in srgb,var(--prw-text) 45%,var(--prw-border));margin-bottom:12px}
</style>
