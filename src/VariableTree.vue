<script setup lang="ts">
import { computed, ref } from 'vue';
import { indexVariables, type VariableLocation, type VariableMacro, type VariableScope } from './variables';
import type { Entry, WorkDocument } from './types';

const props = defineProps<{ doc: WorkDocument; grouping: boolean }>();
const emit = defineEmits<{ close: []; edit: [entry: Entry, location: VariableMacro] }>();
const showEmptySets = defineModel<boolean>('showEmptySets', { required: true });
const index = computed(() => indexVariables(props.doc, undefined, props.grouping));
const filter = ref('all'), query = ref('');
const visible = computed(() => index.value.variables.filter(variable => {
  if (!variable.name.toLowerCase().includes(query.value.trim().toLowerCase())) return false;
  if (filter.value === 'unread') return !!variable.writes.length && !variable.reads.length;
  if (filter.value === 'unwritten') return !!variable.reads.length && !variable.writes.length;
  if (showEmptySets.value && filter.value === 'missingEmpty') return !variable.emptySets.length;
  return true;
}));
const scopes: { id: VariableScope; label: string }[] = [
  { id: 'local', label: '聊天变量' }, { id: 'global', label: '全局变量' },
];
function locationStatus({ entry, paused }: VariableLocation) {
  if (entry.unused) return '未加入列表';
  if (!entry.enabled) return '条目已关闭';
  return paused ? '分组已停用' : '';
}
</script>

<template>
  <section class="variable-tree" role="dialog" aria-label="预设变量">
    <header><strong>{{ doc.ref.label }} · 变量</strong><button aria-label="关闭变量" @click="emit('close')">✕</button></header>
    <div class="variable-tree-filters">
      <input v-model="query" type="search" placeholder="搜索变量" aria-label="搜索变量" />
      <select v-model="filter" aria-label="变量关系筛选">
        <option value="all">全部</option>
        <option value="unread">有写入，未见 get</option>
        <option value="unwritten">有 get，未见 set</option>
        <option v-if="showEmptySets" value="missingEmpty">未见空值初始化</option>
      </select>
    </div>
    <label class="compact-check"><input v-model="showEmptySets" type="checkbox"
      @change="filter === 'missingEmpty' && (filter = 'all')" />检查空值初始化</label>
    <div class="variable-tree-list">
      <small v-if="!visible.length">没有匹配的变量</small>
      <details v-for="scope in scopes.filter(scope => visible.some(v => v.scope === scope.id))" :key="scope.id" open>
        <summary>{{ scope.label }}</summary>
        <details v-for="variable in visible.filter(v => v.scope === scope.id)" :key="variable.key" class="variable-tree-item">
          <summary><strong>{{ variable.name }}</strong> <small>set {{ variable.writes.length }} · get {{ variable.reads.length }}<template v-if="showEmptySets"> · {{ variable.emptySets.length ? '空值初始化 ' + variable.emptySets.length : '未见空值初始化' }}</template></small></summary>
          <template v-for="branch in [{label:'写入', items:variable.writes},{label:'引用', items:variable.reads},{label:'其他操作', items:variable.other}]" :key="branch.label">
            <div v-if="branch.items.length" class="variable-branch">
              <small>{{ branch.label }}</small>
              <button v-for="location in branch.items" :key="location.entry.id + '/' + location.macro.start" type="button"
                @click="emit('edit', location.entry, location.macro)">
                <span>{{ location.entry.name }} <small v-if="showEmptySets && variable.emptySets.includes(location)">空值初始化 </small><small>{{ locationStatus(location) }}</small></span>
                <code>{{ location.entry.content.slice(location.macro.start, Math.min(location.macro.end, location.macro.start + 95)) }}</code>
              </button>
            </div>
          </template>
          <small v-if="variable.reads.length && !variable.writes.length">本预设未见 set，值可能来自其他来源。</small>
        </details>
      </details>
      <details v-if="index.issues.length">
        <summary>待确认 · {{ index.issues.length }}</summary>
        <div v-for="issue in index.issues" :key="issue.entry.id + issue.message" class="variable-issue">{{ issue.entry.name }} · {{ issue.message }}</div>
      </details>
    </div>
  </section>
</template>

<style>
#prw-panel .variable-shade { justify-content: flex-end; }
#prw-panel .variable-tree { display:flex; flex-direction:column; gap:10px; width:min(460px, 100%); min-width:0; height:100%; overflow:hidden; padding:14px; border:1px solid var(--prw-border); border-radius:12px; background:var(--prw-bg); }
#prw-panel .variable-tree header, #prw-panel .variable-tree-filters { display:flex; align-items:center; justify-content:space-between; gap:8px; }
#prw-panel .variable-tree header strong { overflow-wrap:anywhere; }
#prw-panel .variable-tree-filters input { min-width:0; flex:1; }
#prw-panel .variable-tree-filters select { width:auto; max-width:50%; }
#prw-panel .variable-tree-list { overflow:auto; min-height:0; }
#prw-panel .variable-tree summary { cursor:pointer; padding:7px 0; overflow-wrap:anywhere; }
#prw-panel .variable-tree-item { padding-left:12px; border-bottom:1px solid var(--prw-border); }
#prw-panel .variable-branch { display:grid; gap:5px; margin:6px 0 10px; min-width:0; }
#prw-panel .variable-branch button { display:grid; gap:4px; min-width:0; text-align:left; overflow-wrap:anywhere; }
#prw-panel .variable-branch code { white-space:pre-wrap; }
#prw-panel .variable-issue { margin:5px 0; overflow-wrap:anywhere; }
</style>
