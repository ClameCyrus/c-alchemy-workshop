<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { clone, entryFrom, rawEntry, stable, uid } from './core';
import { customLibraryItem, moveLibraryItems, readLibrary, splitLibraryItem, worldbookLibraryItem, type LibraryItem, type EntryLibraryData } from './library';
import LibraryInsert from './LibraryInsert.vue';
import CategoryPicker from './CategoryPicker.vue';
import RegexFields from './RegexFields.vue';
import type { Host, Raw, WorkDocument } from './types';

const props = defineProps<{ host: Host; capture?: LibraryItem; documents: WorkDocument[]; target?: string; loadTarget: (key: string) => Promise<void>; bodyMode?: boolean; grouping: boolean; folds: Record<string, boolean> }>();
const emit = defineEmits<{ close: []; apply: [key: string, baseline: string, next: WorkDocument]; text: [text: string] }>();
const data = ref<EntryLibraryData>({ version: 1, items: [], folders: [] }), baseline = ref(''), loading = ref(true), saving = ref(false), error = ref('');
const draft = ref<LibraryItem | null>(props.capture ? clone(props.capture) : null), draftBaseline = ref(stable(draft.value));
const query = ref(''), folder = ref(''), selected = ref<string[]>([]), stage = ref(false), deleting = ref<string | null>(null), discarding = ref(false);
const category = ref<{ mode: 'add' | 'rename' | 'move'; old: string; name: string } | null>(null), folds = computed(() => props.folds);
const books = ref<string[]>([]), bookQuery = ref(''), worldName = ref(''), world = ref<Raw | null>(null), worldIds = ref<string[]>([]), worldQuery = ref(''), worldOpen = ref(false), worldBusy = ref(false);
const root = ref<HTMLElement>(), file = ref<HTMLInputElement>();
const previousFocus = document.activeElement as HTMLElement | null;
let request = 0, stopped = false;
const folders = computed(() => data.value.folders);
const list = computed(() => data.value.items.filter(i => (!folder.value || (folder.value === '__none' ? !i.folder : i.folder === folder.value)) &&
  `${i.name}\n${i.folder}\n${i.source.name}\n${i.entries.map(e => `${e.name}\n${e.content}`).join('\n')}`.toLowerCase().includes(query.value.toLowerCase())));
const sections = computed(() => [...folders.value, ''].filter(name => !folder.value || (folder.value === '__none' ? !name : name === folder.value)).map(name => ({ name, items: list.value.filter(i => i.folder === name) }))
  .filter(s => s.items.length || (!query.value && (s.name || !data.value.items.length))));
const filteredBooks = computed(() => books.value.filter(n => n.toLowerCase().includes(bookQuery.value.trim().toLowerCase())));
const chosen = computed(() => data.value.items.filter(i => selected.value.includes(i.id)));
const changed = computed(() => !!draft.value && stable(draft.value) !== draftBaseline.value);
const worldList = computed(() => Object.entries(world.value?.entries || {}).filter(([, r]: [string, any]) => `${r.comment || ''}\n${r.content || ''}`.toLowerCase().includes(worldQuery.value.toLowerCase())));
async function load() {
  loading.value = true;
  try {
    if (!props.host.loadLibrary || !props.host.saveLibrary) throw new Error('当前宿主未提供条目库存储');
    const value = readLibrary(await props.host.loadLibrary());
    if (stopped) return;
    data.value = value; baseline.value = stable(value); error.value = '';
  } catch (e) { error.value = (e as Error).message; }
  finally { loading.value = false; }
}
async function persist(next: EntryLibraryData) {
  if (saving.value || !baseline.value || !props.host.saveLibrary) return false;
  saving.value = true;
  try {
    const value = readLibrary(next);
    await props.host.saveLibrary(value, baseline.value);
    data.value = value; baseline.value = stable(value); error.value = ''; return true;
  } catch (e) { error.value = (e as Error).message; return false; }
  finally { saving.value = false; }
}
function edit(item: LibraryItem) { draft.value = clone(item); draftBaseline.value = stable(item); error.value = ''; }
function create(folderName = folder.value === '__none' ? '' : folder.value) {
  const item = customLibraryItem(); item.folder = folderName; edit(item);
}
async function saveDraft() {
  if (!draft.value || !draft.value.name.trim() || draft.value.entries.some(e => !e.name.trim())) return;
  const item = clone(draft.value); item.name = item.name.trim(); item.folder = item.folder.trim(); item.updated = Date.now();
  if (item.entries.length === 1) item.entries[0].name = item.name;
  if (item.kind === 'regex') item.entries.forEach(e => { e.content = entryFrom(e.raw, 'regex').content; });
  item.entries.forEach(e => { e.raw = rawEntry(e, item.kind); });
  const rows = splitLibraryItem(item).map((row, i) => ({ ...row, id: i ? uid() : item.id }));
  const next = clone(data.value), index = next.items.findIndex(i => i.id === item.id);
  if (index < 0) next.items.push(...rows); else next.items.splice(index, 1, ...rows);
  if (item.folder && !next.folders.includes(item.folder)) next.folders.push(item.folder);
  if (await persist(next)) { selected.value = rows.map(i => i.id); draft.value = null; }
}
function cancelEdit() { if (changed.value) discarding.value = true; else draft.value = null; }
function close() {
  if (saving.value) return;
  if (category.value) { category.value = null; return; }
  if (deleting.value || discarding.value) { deleting.value = null; discarding.value = false; return; }
  if (draft.value) { cancelEdit(); return; }
  if (stage.value) { stage.value = false; return; }
  emit('close');
}
async function erase() {
  const next = clone(data.value); next.items = next.items.filter(i => i.id !== deleting.value);
  if (await persist(next)) { selected.value = selected.value.filter(id => id !== deleting.value); deleting.value = null; }
}
function download() {
  if (!baseline.value) return;
  const value = clone(data.value);
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'Cの炼金工坊-条目库.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement, item = input.files?.[0];
  if (!item) return;
  try {
    const imported = readLibrary(JSON.parse(await item.text())), next = clone(data.value);
    next.items.push(...imported.items.map(i => ({ ...clone(i), id: uid(), updated: Date.now() })));
    next.folders = [...new Set([...next.folders, ...imported.folders])];
    if (imported.legacyCollections) next.legacyCollections = [...(next.legacyCollections || []), ...clone(imported.legacyCollections)];
    await persist(next);
  } catch (e) { error.value = (e as Error).message; }
  finally { input.value = ''; }
}
async function openWorlds() {
  try {
    if (!props.host.worldbooks || !props.host.loadWorldbook) throw new Error('当前宿主未提供世界书读取');
    books.value = await props.host.worldbooks(); worldOpen.value = true; error.value = '';
  } catch (e) { error.value = (e as Error).message; }
}
async function selectWorld() {
  const ticket = ++request, name = worldName.value;
  world.value = null; worldIds.value = [];
  if (!name) { worldBusy.value = false; return; }
  worldBusy.value = true;
  try { const value = await props.host.loadWorldbook!(name); if (!stopped && ticket === request) { world.value = value; error.value = ''; } }
  catch (e) { if (ticket === request) error.value = (e as Error).message; }
  finally { if (ticket === request) worldBusy.value = false; }
}
function collectWorld() {
  try { const item = worldbookLibraryItem(worldName.value, world.value!, worldIds.value); item.folder = folder.value === '__none' ? '' : folder.value; edit(item); worldOpen.value = false; }
  catch (e) { error.value = (e as Error).message; }
}
function toggle(ids: string[]) {
  if (props.bodyMode) ids = ids.filter(id => data.value.items.some(i => i.id === id && i.kind === 'preset'));
  selected.value = ids.every(id => selected.value.includes(id)) ? selected.value.filter(id => !ids.includes(id)) : [...new Set([...selected.value, ...ids])];
}
async function saveCategory() {
  const form = category.value; if (!form) return;
  const name = form.name.trim();
  if (form.mode !== 'move' && !name) { error.value = '填写分类名称'; return; }
  if (form.mode !== 'move' && folders.value.includes(name) && name !== form.old) { error.value = '分类已存在'; return; }
  let next = clone(data.value);
  if (form.mode === 'move') next = moveLibraryItems(next, selected.value, name);
  else if (form.mode === 'add') { if (!next.folders.includes(name)) next.folders.push(name); }
  else { next.folders = next.folders.map(f => f === form.old ? name : f); next.items.forEach(i => { if (i.folder === form.old) i.folder = name; }); }
  if (await persist(next)) {
    if (folder.value === form.old && form.mode === 'rename') folder.value = name;
    if (draft.value && form.mode === 'add') draft.value.folder = name;
    category.value = null;
  }
}
function beginInsert() {
  if (!chosen.value.length) return;
  if (new Set(chosen.value.map(i => i.kind)).size > 1) { error.value = '预设条目和正则请分别插入'; return; }
  if (props.bodyMode) { emit('text', chosen.value.flatMap(i => i.entries.map(e => e.content)).join('\n\n')); return; }
  stage.value = true;
}
function trap(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const focusable = [...root.value!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(e => e.getClientRects().length);
  const first = focusable[0], last = focusable.at(-1);
  if (!root.value!.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
  else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
const unload = (event: BeforeUnloadEvent) => { if (changed.value || saving.value) { event.preventDefault(); event.returnValue = ''; } };
onMounted(async () => { window.addEventListener('beforeunload', unload); await load(); await nextTick(); root.value?.querySelector<HTMLElement>('button')?.focus(); });
onBeforeUnmount(() => { stopped = true; request++; window.removeEventListener('beforeunload', unload); if (previousFocus?.isConnected) previousFocus.focus(); });
</script>

<template>
  <div ref="root" class="library-shade" @keydown="trap" @keydown.esc.stop.prevent="close">
    <LibraryInsert v-if="stage" :items="chosen" :documents="documents.filter(d => d.ref.kind === chosen[0]?.kind)" :available="host.resources(chosen[0].kind)" :load-target="loadTarget" :initial-target="target" :grouping="grouping" @close="stage = false" @apply="(key, before, next) => emit('apply', key, before, next)" />
    <section v-else class="entry-library" role="dialog" aria-label="条目库" aria-modal="true">
      <header><strong>{{ draft ? (draft.entries.length > 1 ? `收藏 ${draft.entries.length} 条` : '编辑条目') : '条目库' }}</strong><button aria-label="关闭条目库" :disabled="saving" @click="close">✕</button></header>
      <div v-if="error && !category" class="library-error" role="alert">{{ error }}</div>
      <template v-if="draft">
        <form class="library-scroll" :inert="saving" @submit.prevent="saveDraft">
          <label v-if="draft.entries.length === 1">名称<input v-model="draft.name" required aria-label="条目名称" /></label>
          <label>分类<CategoryPicker v-model="draft.folder" :folders="folders" label="条目分类" /></label>
          <small v-if="draft.source.name">来源 · {{ draft.source.name }}</small>
          <small v-if="draft.source.type === 'worldbook'">插入预设时仅使用正文，触发规则保留在来源备份中。</small>
          <article v-for="entry in draft.entries" :key="entry.id" class="library-card">
            <label v-if="draft.entries.length > 1">条目名称<input v-model="entry.name" aria-label="收藏条目名称" /></label>
            <template v-if="draft.kind === 'preset'"><label>角色<select v-model="entry.role"><option value="system">系统</option><option value="user">用户</option><option value="assistant">AI</option></select></label><label>正文<textarea v-model="entry.content" rows="10" aria-label="条目正文"></textarea></label></template>
            <RegexFields v-else :raw="entry.raw" />
          </article>
        </form>
        <footer><button :disabled="saving" @click="cancelEdit">取消</button><button class="primary" :disabled="saving || loading || !baseline" @click="saveDraft">{{ saving ? '保存中…' : '保存条目' }}</button></footer>
      </template>
      <template v-else-if="worldOpen">
        <div class="library-scroll">
          <input v-model="bookQuery" type="search" placeholder="搜索世界书名称" aria-label="搜索世界书名称" />
          <label>世界书<select v-model="worldName" aria-label="收藏世界书" @change="selectWorld"><option value="">选择世界书</option><option v-if="worldName && !filteredBooks.includes(worldName)" :value="worldName">已选 · {{ worldName }}</option><option v-for="name in filteredBooks" :key="name" :value="name">{{ name }}</option></select></label>
          <div class="library-fields"><input v-model="worldQuery" type="search" placeholder="搜索名称或正文" aria-label="搜索世界书条目" /><button @click="worldIds = worldList.every(([id]) => worldIds.includes(id)) ? worldIds.filter(id => !worldList.some(([key]) => key === id)) : [...new Set([...worldIds, ...worldList.map(([id]) => id)])]">全选</button></div>
          <p v-if="worldBusy">读取中…</p>
          <article v-for="[id, row] in worldList" :key="id" class="library-card"><label class="library-check"><input v-model="worldIds" type="checkbox" :value="id" :aria-label="`收藏 ${row.comment || id}`" /><strong>{{ row.comment || row.key?.join('、') || id }}</strong></label><p>{{ String(row.content || '').slice(0, 180) }}</p></article>
        </div>
        <footer><button @click="worldOpen = false; request++; worldBusy = false">返回</button><button class="primary" :disabled="!world || !worldIds.length || worldBusy" @click="collectWorld">收藏 · {{ worldIds.length }}</button></footer>
      </template>
      <template v-else>
        <nav class="library-fields"><button :disabled="loading || saving" @click="create()">新建条目</button><button :disabled="loading || saving" @click="category = {mode:'add',old:'',name:''}">新建分类</button><button :disabled="loading || saving" @click="openWorlds">收藏世界书</button><button :disabled="loading || saving" @click="file?.click()">导入</button><button :disabled="loading || !baseline" @click="download">导出</button><button :disabled="saving" @click="load">重新载入</button><input ref="file" type="file" accept="application/json,.json" hidden @change="importFile" /></nav>
        <div class="library-fields"><input v-model="query" type="search" placeholder="搜索条目" aria-label="搜索条目" /><select v-model="folder" aria-label="条目分类筛选"><option value="">所有分类</option><option value="__none">未分类</option><option v-for="f in folders" :key="f" :value="f">{{ f }}</option></select><button @click="toggle(list.map(i => i.id))">全选</button></div>
        <div class="library-scroll">
          <p v-if="loading">读取中…</p><p v-else-if="!sections.length">没有找到条目</p>
          <section v-for="section in sections" :key="section.name" class="library-category" :data-category="section.name">
            <header class="library-category-header"><button :aria-expanded="!folds[section.name]" @click="folds[section.name] = !folds[section.name]">{{ folds[section.name] ? '▸' : '▾' }} {{ section.name || '未分类' }} · {{ section.items.length }}</button><button @click="create(section.name)">添加条目</button><button v-if="section.name" @click="category = {mode:'rename',old:section.name,name:section.name}">改名</button></header>
            <template v-if="!folds[section.name] || query"><article v-for="item in section.items" :key="item.id" class="library-card">
              <label class="library-check"><input v-model="selected" type="checkbox" :value="item.id" :disabled="bodyMode && item.kind !== 'preset'" :aria-label="`选择条目 ${item.name}`" /><strong>{{ item.name }}</strong><small>{{ item.kind === 'regex' ? '正则' : '预设' }}</small></label>
              <p class="library-excerpt">{{ item.entries[0]?.content.slice(0, 160) }}</p><small v-if="item.source.name">来源 · {{ item.source.name }}</small>
              <div class="library-fields"><button :disabled="saving" @click="edit(item)">编辑</button><button :disabled="saving" @click="selected = [item.id]; category = {mode:'move',old:'',name:item.folder}">移动分类</button><button class="danger" :disabled="saving" @click="deleting = item.id">删除…</button></div>
            </article></template>
          </section>
        </div>
        <footer><small>已选 {{ chosen.length }} 条</small><button v-if="chosen.length" :disabled="saving" @click="category = {mode:'move',old:'',name:''}">移动分类 · {{ chosen.length }}</button><button class="primary" :disabled="!chosen.length || loading || saving" @click="beginInsert">{{ bodyMode ? '插入正文' : '插入到…' }}</button></footer>
      </template>
      <form v-if="category" class="library-confirm" role="dialog" aria-label="分类设置" @submit.prevent="saveCategory">
        <strong>{{ category.mode === 'move' ? '移动到分类' : category.mode === 'rename' ? '分类改名' : '新建分类' }}</strong><div v-if="error" class="library-error" role="alert">{{ error }}</div><label>分类名称<CategoryPicker v-if="category.mode === 'move'" v-model="category.name" :folders="folders" label="分类名称" :disabled="saving" /><input v-else v-model="category.name" :disabled="saving" aria-label="分类名称" /></label>
        <footer><button type="button" :disabled="saving" @click="category = null; error = ''">取消</button><button class="primary" type="submit" :disabled="saving">确定</button></footer>
      </form>
      <div v-if="deleting || discarding" class="library-confirm" role="alertdialog" :aria-label="deleting ? '删除条目' : '放弃条目编辑'">
        <strong>{{ deleting ? '删除条目？' : '放弃本次条目编辑？' }}</strong><p v-if="deleting">{{ data.items.find(i => i.id === deleting)?.name }} · 原预设和世界书保留。</p>
        <footer><button :disabled="saving" @click="deleting = null; discarding = false">取消</button><button class="danger" :disabled="saving" @click="deleting ? erase() : (draft = null, discarding = false)">确定</button></footer>
      </div>
    </section>
  </div>
</template>

<style>
#prw-mount .library-shade{position:absolute;inset:0;z-index:25;display:flex;align-items:center;justify-content:center;background:var(--prw-shade);padding:16px;min-width:0;box-sizing:border-box}
#prw-mount :is(.entry-library,.library-insert){position:relative;display:flex;flex-direction:column;gap:12px;width:min(1040px,100%);height:min(900px,100%);min-height:0;min-width:0;padding:18px;box-sizing:border-box;overflow:hidden;background:var(--prw-surface);color:var(--prw-text);border:1px solid var(--prw-border);border-radius:12px;box-shadow:0 20px 70px var(--prw-shadow);font:13px/1.5 system-ui}
#prw-mount :is(.entry-library,.library-insert) :is(header,footer){display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;flex-shrink:0;min-width:0;background:transparent}
#prw-mount :is(.entry-library,.library-insert) label{display:flex;flex-direction:column;gap:5px;min-width:0}
#prw-mount .library-scroll{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:2px}
#prw-mount .library-scroll>*{flex-shrink:0}
#prw-mount .library-fields{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}
#prw-mount .library-fields>label{flex:1;min-width:120px}
#prw-mount .library-fields>input[type=search]{flex:1;min-width:100px}
#prw-mount .library-card{display:flex;flex-direction:column;gap:9px;padding:12px;border:1px solid var(--prw-border);border-radius:8px;min-width:0;overflow-wrap:anywhere;background:var(--prw-bg)}
#prw-mount :is(.entry-library,.library-insert) .library-check{display:flex;flex-direction:row;align-items:center;flex-wrap:wrap;gap:7px}
#prw-mount :is(.entry-library,.library-insert) :is(input,select,textarea){font:inherit;padding:7px 9px;margin:0;max-width:100%;min-width:0;border:1px solid var(--prw-border);border-radius:7px;box-sizing:border-box}
#prw-mount :is(.entry-library,.library-insert) textarea{width:100%;resize:vertical;min-height:60px;line-height:1.65;white-space:pre-wrap}
#prw-mount :is(.entry-library,.library-insert) button{font:inherit;padding:7px 10px;margin:0;border:1px solid var(--prw-border);border-radius:7px;cursor:pointer;line-height:1.25}
#prw-mount :is(.entry-library,.library-insert) button:disabled{opacity:.4;cursor:default}
#prw-mount :is(.entry-library,.library-insert) button:focus-visible{outline:2px solid var(--prw-accent);outline-offset:1px}
#prw-mount :is(.entry-library,.library-insert) :is(pre,p){margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;color:inherit}
#prw-mount :is(.entry-library,.library-insert) pre{font:12px/1.7 ui-monospace,monospace;background:transparent;border:0;text-shadow:none}
#prw-mount :is(.entry-library,.library-insert) small{color:var(--prw-muted)}
#prw-mount .library-error{padding:8px;border:1px solid var(--prw-danger);color:var(--prw-danger);overflow-wrap:anywhere}
#prw-mount .library-warning{padding:7px;border-left:2px solid var(--prw-accent)}
#prw-mount .library-confirm{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;justify-content:center;gap:18px;padding:24px;box-sizing:border-box;background:var(--prw-bg);overflow:auto}
#prw-mount .library-category{display:flex;flex-direction:column;gap:9px;min-width:0}
#prw-mount .library-category-header{position:sticky;top:0;padding:6px 0;background:var(--prw-surface)!important;border-bottom:1px solid var(--prw-border);z-index:1}
#prw-mount .library-category-header>button:first-child{flex:1;min-width:0;text-align:left;overflow-wrap:anywhere}
#prw-mount .library-excerpt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
@media(max-width:760px){#prw-mount .library-shade{padding:0}#prw-mount :is(.entry-library,.library-insert){width:100%;height:100%;border:0;border-radius:0;padding:12px;gap:9px;font-size:12px}#prw-mount .library-card{padding:9px}#prw-mount .library-fields>label{min-width:100px}}
</style>
