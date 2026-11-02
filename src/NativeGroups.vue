<script setup lang="ts">
import { computed, ref } from 'vue';
import type { NativeModel } from './native-model';
const props = defineProps<{
  model: NativeModel;
  fold: (id: string) => Promise<void>;
  enable: (id: string, enabled: boolean) => Promise<void>;
  entry: (id: string, enabled: boolean) => Promise<void>;
  more: (row: HTMLElement, button: HTMLElement) => void;
  edit: (id: string) => void;
  select: (id: string, checked: boolean) => void;
}>();
const busy = ref(false), selected = ref<Record<string, boolean>>({});
const sections = computed(() => {
  const map = new Map(props.model.entries.map(e => [e.id, e]));
  const used = new Set(props.model.groups.flatMap(g => g.members));
  return [
    ...props.model.groups.map(g => ({ ...g, items: g.members.map(id => map.get(id)).filter(Boolean) as typeof props.model.entries })),
    { id: '', name: '未分组', members: [], collapsed: false, enabled: true, items: props.model.entries.filter(e => !used.has(e.id)) },
  ].filter(g => g.items.length || g.id);
});
async function act(fn: () => Promise<void>) { if (busy.value) return; busy.value = true; try { await fn(); } finally { busy.value = false; } }
function select(id: string, value: boolean) { selected.value[id] = value; props.select(id, value); }
</script>
<template>
  <div class="prw-native-groups" @pointerdown.stop @mousedown.stop>
    <section v-for="group in sections" :key="group.id" class="native-group" :class="{'group-paused':!group.enabled}" :data-group-id="group.id">
      <header>
        <button class="group-name" :disabled="!group.id || busy" :aria-label="`${group.collapsed ? '展开' : '折叠'} ${group.name}`" @click="act(() => fold(group.id))">
          <span>{{ group.collapsed ? '▸' : '▾' }}</span><strong>{{ group.name }}</strong><small>{{ group.items.length }}</small>
        </button>
        <small v-if="!group.enabled" class="paused-label">已暂停</small>
        <button v-if="group.id" :disabled="busy" :aria-label="`${group.enabled ? '暂停' : '启用'} ${group.name}`" :title="group.enabled ? '暂停本组，保留条目开关' : '启用本组，保留条目开关'" @click="act(() => enable(group.id, !group.enabled))">{{ group.enabled ? '暂停' : '启用' }}</button>
      </header>
      <div v-show="!group.collapsed" class="group-items">
        <div v-for="item in group.items" :key="item.id" class="prw-native-row" :class="{'item-disabled':!item.enabled}" :data-prw-kind="model.ref.kind" :data-prw-ref-key="model.ref.key" :data-prw-ref-name="model.ref.name" :data-pm-identifier="model.ref.kind==='preset' ? item.id : undefined" :data-regex-script-id="model.ref.kind==='regex' ? item.id : undefined" :data-regex-type="model.ref.scope">
          <input v-if="model.ref.kind==='regex'" type="checkbox" class="prw-native-selection" :aria-label="`选择 ${item.name}`" :checked="!!selected[item.id]" @change="select(item.id,($event.target as HTMLInputElement).checked)" />
          <span class="item-name" :title="item.name" @dblclick="edit(item.id)">{{ item.name }}</span>
          <button class="item-toggle" :disabled="busy" :aria-label="`${item.enabled ? '关闭' : '开启'} ${item.name}`" title="条目原开关" @click="act(() => entry(item.id,!item.enabled))">{{ item.enabled ? '●' : '○' }}</button>
          <button class="prw-row-more" aria-label="更多" title="更多" @click="more(($event.currentTarget as HTMLElement).closest('.prw-native-row') as HTMLElement,$event.currentTarget as HTMLElement)"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg></button>
        </div>
      </div>
    </section>
  </div>
</template>
<style scoped>
.prw-native-groups{color:var(--prw-text);font:inherit;min-width:0;width:100%;display:grid;gap:8px}
.native-group{border:1px solid var(--prw-border);border-radius:8px;overflow:hidden;min-width:0;background:var(--prw-bg)}
.native-group header{display:flex;align-items:center;gap:7px;padding:6px 8px;background:var(--prw-surface)}
.native-group button{font:inherit;color:inherit;border:1px solid var(--prw-border);border-radius:5px;padding:3px 7px;margin:0;background:transparent;cursor:pointer;width:auto;min-width:0;box-shadow:none;text-shadow:none}
.native-group button:disabled{cursor:default}.native-group .group-name{display:flex;align-items:center;gap:7px;flex:1;text-align:left;border:0;padding:2px 0;overflow:hidden;white-space:nowrap}.group-name strong{font-weight:600;overflow:hidden;text-overflow:ellipsis}.group-name small{color:var(--prw-muted)}
.paused-label{font-size:11px;color:var(--prw-warning);white-space:nowrap}.group-items{padding:3px 7px}.prw-native-row{display:flex;align-items:center;gap:7px;min-width:0;min-height:34px;border-bottom:1px solid var(--prw-border)}.prw-native-row:last-child{border:0}.item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.item-disabled .item-name{opacity:.55}.item-toggle{border:0!important;color:var(--prw-accent)!important}.prw-native-selection{width:16px;height:16px;flex:none;margin:0}.group-paused .group-items{opacity:.7}
@media(max-width:480px){.native-group header{gap:5px}.native-group button{font-size:12px}.prw-native-row{font-size:13px}}
</style>
