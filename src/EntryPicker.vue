<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { browseRows } from './browse-rows';
import { groupOf } from './core';
import type { WorkDocument } from './types';
export interface EntryPosition { id: string; after: boolean; groupId: string }
const props = defineProps<{ doc: WorkDocument; mode: 'position' | 'entry'; selected?: string; grouping: boolean; allowNew?: boolean; staged?: Record<string, string> }>();
const emit = defineEmits<{ position: [position: EntryPosition]; choose: [id: string]; remove: [key: string] }>();
const query = ref(''), group = ref(''), folds = ref<Record<string, boolean>>({});
const entriesRoot = ref<HTMLElement>();
watch(() => props.doc.ref.key, () => { query.value = ''; group.value = ''; folds.value = {}; });
const rows = computed(() => {
  const q = query.value.trim().toLowerCase();
  const entries = props.doc.entries.filter(e => (!q || `${e.name}\n${e.content}`.toLowerCase().includes(q)) && (!props.grouping || !group.value || (group.value === '__none' ? !groupOf(props.doc, e.id) : groupOf(props.doc, e.id)?.id === group.value)));
  return browseRows(entries, props.grouping ? props.doc.state.groups : [], id => !!folds.value[id], !!q);
});
async function place(id: string, after: boolean, groupId?: string) {
  const before = new Set(Object.keys(props.staged || {}));
  emit('position', { id, after, groupId: props.grouping ? groupId ?? groupOf(props.doc, id)?.id ?? '' : '' });
  query.value = ''; group.value = '';
  await nextTick();
  const added = Object.keys(props.staged || {}).filter(key => !before.has(key)).at(-1);
  if (added) entriesRoot.value?.querySelector<HTMLElement>(`[data-picker-id="${CSS.escape(added)}"]`)?.scrollIntoView({ block: 'nearest' });
}
</script>
<template>
  <div class="entry-picker">
    <div class="material-fields"><input v-model="query" type="search" placeholder="搜索条目名称或正文" aria-label="搜索目标条目" /><select v-if="grouping && doc.state.groups.length" v-model="group" aria-label="目标分组筛选"><option value="">全部分组</option><option value="__none">未分组</option><option v-for="g in doc.state.groups" :key="g.id" :value="g.id">{{ g.name }}</option></select></div>
    <div ref="entriesRoot" class="picker-entries">
      <button v-if="mode === 'position'" class="picker-end" @click="place(doc.entries[0]?.id || '', false, '')">列表开头</button>
      <button v-if="allowNew" class="picker-end" :class="{active:selected==='__new'}" @click="emit('choose','__new')">新建初始化条目</button>
      <template v-for="row in rows" :key="row.key">
        <div v-if="row.type === 'group'" class="picker-group">
          <button :aria-label="`${row.collapsed ? '展开' : '折叠'}目标分组 ${row.group.name}`" @click="folds[row.group.id] = !folds[row.group.id]">{{ row.collapsed ? '▸' : '▾' }} {{ row.group.name }} · {{ row.count }}{{ row.group.enabled ? '' : ' · 已停用' }}</button>
          <button v-if="mode === 'position'" :aria-label="`插入${row.group.name}组末尾`" @click="place(doc.entries.filter(e => row.group.members.includes(e.id)).at(-1)?.id || '', true, row.group.id)">组末尾</button>
        </div>
        <article v-else class="picker-entry" :class="{active:selected===row.entry.id,grouped:grouping && !!groupOf(doc,row.entry.id)}" :data-picker-id="row.entry.id">
          <strong>{{ row.entry.name }} <small v-if="!row.entry.enabled">已关闭</small></strong>
          <p>{{ row.entry.content.slice(0,150) || '—' }}</p>
          <div v-if="staged?.[row.entry.id]" class="material-fields"><small>本次插入</small><button :aria-label="`移除已插入素材 ${row.entry.name}`" @click="emit('remove',staged[row.entry.id])">移回素材</button></div>
          <div class="material-fields" v-if="mode === 'position'"><button :aria-label="`在${row.entry.name}前面插入`" @click="place(row.entry.id,false)">前面</button><button :aria-label="`在${row.entry.name}后面插入`" @click="place(row.entry.id,true)">后面</button></div>
          <button v-else-if="!staged?.[row.entry.id]" :disabled="!!row.entry.raw.marker" :aria-label="`选择目标条目 ${row.entry.name}`" @click="emit('choose',row.entry.id)">选择此条目</button>
        </article>
      </template>
      <p v-if="!rows.length">没有找到条目</p>
      <button v-if="mode === 'position'" class="picker-end" @click="place('',false,'')">列表末尾</button>
    </div>
  </div>
</template>
<style>
#prw-mount .entry-picker{display:flex;flex-direction:column;gap:9px;min-height:0;min-width:0;flex:1}
#prw-mount .picker-entries{display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto;overscroll-behavior:contain;padding:2px}
#prw-mount .picker-entry{display:flex;flex-direction:column;gap:7px;padding:11px;border:1px solid var(--prw-border);border-radius:8px;min-width:0;overflow-wrap:anywhere;background:var(--prw-bg)}
#prw-mount .picker-entry.grouped{margin-left:10px;border-left:3px solid var(--prw-border)}
#prw-mount .picker-entry.active{border-color:var(--prw-accent);background:var(--prw-active)}
#prw-mount .picker-group{display:flex;gap:6px;align-items:center;border-bottom:1px solid var(--prw-border);padding:3px 0}
#prw-mount .picker-group>button:first-child{flex:1;text-align:left;min-width:0;overflow-wrap:anywhere}
#prw-mount .picker-entry p{font-size:12px;color:var(--prw-muted)!important}
#prw-mount .picker-end{text-align:center}
</style>
