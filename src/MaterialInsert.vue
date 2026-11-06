<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { clone, serialize, stable } from './core';
import { materialParts, insertionVariables, insertMaterials, type MaterialPart, type VariableBinding } from './material-insertion';
import { scanVariables, variableKey, variableMacro } from './variables';
import { summarizeChanges } from './change-summary';
import EntryPicker from './EntryPicker.vue';
import RegexFields from './RegexFields.vue';
import type { Material } from './library';
import type { Resource, WorkDocument } from './types';

const props = defineProps<{ items: Material[]; documents: WorkDocument[]; available: Resource[]; loadTarget: (key: string) => Promise<void>; initialTarget?: string; grouping: boolean }>();
const emit = defineEmits<{ close: []; apply: [key: string, baseline: string, next: WorkDocument] }>();
const targetKey = ref(props.available.some(r => r.key === props.initialTarget) ? props.initialTarget! : props.available[0]?.key || '');
const target = computed(() => props.documents.find(d => d.ref.key === targetKey.value));
const parts = ref(materialParts(props.items)), bindings = ref<VariableBinding[]>([]);
const placing = ref(parts.value.map(p => p.key)), enabled = ref(false);
const task = ref<'position' | 'init' | 'reference'>('position'), mobile = ref<'source' | 'target'>('source');
const initId = ref(''), initEnabled = ref(true), referenceId = ref(''), referenceText = ref(''), referenceEditing = ref(false);
const referenceArea = ref<HTMLTextAreaElement>(), preview = ref<ReturnType<typeof insertMaterials> | null>(null), problem = ref('');
const loading = ref(false), loadFailed = ref(false);
let targetRequest = 0;
const included = computed(() => parts.value.filter(p => p.selected));
const remaining = computed(() => included.value.filter(p => !p.position));
const placed = computed(() => included.value.filter(p => p.position));
const positioned = computed(() => included.value.filter(p => p.position).length);
const stagePlan = ref<ReturnType<typeof insertMaterials> | null>(null), stageError = ref('');
const prefix = ref(''), suffix = ref(''), bulkAll = ref(false);
const targetVariableKeys = computed(() => new Set(target.value?.entries.flatMap(e => scanVariables(e.content).macros.map(m => variableKey(m.scope, m.name))) || []));
const variables = computed(() => { try { return props.items[0]?.kind === 'preset' ? insertionVariables(parts.value) : []; } catch { return []; } });
watch(variables, values => {
  bindings.value = values.map(v => bindings.value.find(b => b.key === v.key) || {
    key: v.key, scope: v.scope, from: v.name, to: v.name, share: true, initialize: false, initial: '', reference: false,
  });
}, { immediate: true });
watch(targetKey, async key => {
  const ticket = ++targetRequest;
  initId.value = ''; referenceId.value = ''; referenceText.value = ''; referenceEditing.value = false; preview.value = null;
  parts.value.forEach(p => { delete p.position; }); placing.value = remaining.value.map(p => p.key);
  if (!key) { loading.value = false; loadFailed.value = true; return; }
  loading.value = true; loadFailed.value = false;
  try { await props.loadTarget(key); if (ticket === targetRequest) problem.value = ''; }
  catch (e) { if (ticket === targetRequest) { problem.value = (e as Error).message; loadFailed.value = true; } }
  finally { if (ticket === targetRequest) loading.value = false; }
}, { immediate: true });
watch([target, parts, bindings, enabled], () => {
  if (!target.value || !placed.value.length) { stagePlan.value = null; stageError.value = ''; return; }
  try {
    stagePlan.value = insertMaterials(target.value, props.items, placed.value, {
      beforeId: '', after: false, groupId: '', keepGroups: false, enabled: enabled.value,
      initId: '', initEnabled: false, referenceId: '', referenceText: '',
      bindings: bindings.value.map(b => ({ ...clone(b), initialize: false, reference: false })), requirePositions: true,
    }); stageError.value = '';
  } catch (e) { stageError.value = (e as Error).message; }
}, { deep: true, immediate: true });
const displayTarget = computed(() => stagePlan.value?.doc || target.value);
const stagedIds = computed(() => Object.fromEntries(placed.value.filter(p => p.insertedId).map(p => [p.insertedId!, p.key])));
function conflict(binding: VariableBinding) {
  return targetVariableKeys.value.has(variableKey(binding.scope, binding.to)) || bindings.value.some(b => b !== binding && b.scope === binding.scope && b.to === binding.to);
}
function label(position?: MaterialPart['position']) {
  if (!position) return '未选择位置';
  if (!position.id) return '列表末尾';
  const entry = target.value?.entries.find(e => e.id === position.id);
  return `${entry?.name || '位置已失效'} · ${position.after ? '后面' : '前面'}`;
}
function locate(keys: string[]) { placing.value = keys; task.value = 'position'; mobile.value = 'target'; }
function place(position: NonNullable<MaterialPart['position']>) {
  const chosen = remaining.value.filter(p => placing.value.includes(p.key));
  if (!chosen.length) { problem.value = '先选择要定位的素材'; return; }
  chosen.forEach(p => { p.position = clone(position); }); placing.value = []; problem.value = ''; mobile.value = 'source';
}
function returnMaterial(key: string) {
  const part = parts.value.find(p => p.key === key); if (!part?.position) return;
  for (const other of parts.value) if (other.position?.id === part.insertedId) other.position = clone(part.position);
  delete part.position; placing.value = [part.key]; mobile.value = 'source';
}
function applyText() {
  const selected = included.value.filter(p => bulkAll.value || placing.value.includes(p.key));
  if (!selected.length) { problem.value = '先选择要修改的素材'; return; }
  selected.forEach(p => { p.prefix = prefix.value; p.suffix = suffix.value; }); problem.value = '';
}
function selectTask(value: typeof task.value) { task.value = value; mobile.value = 'target'; }
function choose(id: string) {
  if (task.value === 'init') { initId.value = id; mobile.value = 'source'; }
  else { referenceId.value = id; referenceText.value = target.value?.entries.find(e => e.id === id)?.content || ''; referenceEditing.value = true; }
}
function insertReferences() {
  try {
    const text = bindings.value.filter(b => b.reference).map(b => variableMacro(b.scope, b.to)).join('\n');
    if (!text) throw new Error('先勾选要插入的引用');
    const el = referenceArea.value, start = el?.selectionStart ?? referenceText.value.length, end = el?.selectionEnd ?? start;
    referenceText.value = referenceText.value.slice(0, start) + text + referenceText.value.slice(end); problem.value = '';
  } catch (e) { problem.value = (e as Error).message; }
}
function review() {
  try {
    if (loading.value || loadFailed.value) return;
    if (!target.value) throw new Error('先选择目标');
    if (!placed.value.length) throw new Error('先将素材插入目标列表');
    const active = new Set(insertionVariables(placed.value).map(v => v.key));
    preview.value = insertMaterials(target.value, props.items, placed.value, {
      beforeId: '', after: false, groupId: '', keepGroups: false, enabled: enabled.value,
      initId: initId.value, initEnabled: initEnabled.value, referenceId: referenceId.value, referenceText: referenceText.value,
      bindings: props.items[0].kind === 'preset' ? clone(bindings.value.filter(b => active.has(b.key))) : [], requirePositions: true,
    }); problem.value = '';
  } catch (e) { problem.value = (e as Error).message; }
}
function apply() {
  const plan = preview.value; if (!plan || !target.value) return;
  if (stable(target.value) !== plan.baseline) { problem.value = '目标草稿已变化，请返回重新预览'; return; }
  emit('apply', targetKey.value, plan.baseline, plan.doc);
}
const changes = computed(() => {
  if (!preview.value || !target.value) return null;
  const snapshot = serialize(target.value); delete snapshot.file;
  return summarizeChanges({ ...preview.value.doc, snapshot });
});
</script>

<template>
  <section class="material-insert" role="dialog" aria-label="插入素材" @keydown.esc.stop.prevent="emit('close')">
    <header><strong>插入素材</strong><small v-if="!preview">已插入 {{ positioned }} 条 · 待选 {{ remaining.length }} 条</small><button aria-label="关闭插入素材" @click="emit('close')">✕</button></header>
    <div v-if="problem || stageError" role="alert" class="material-error">{{ problem || stageError }}</div>
    <template v-if="!preview">
      <label>目标<select v-model="targetKey" aria-label="素材目标"><option value="">选择预设或范围</option><option v-for="r in available" :key="r.key" :value="r.key">{{ r.label }}</option></select></label>
      <nav class="material-mobile-tabs" role="tablist" aria-label="素材插入视图"><button role="tab" data-material-tab="source" :aria-selected="mobile === 'source'" :class="{active:mobile==='source'}" @click="mobile='source'">素材</button><button role="tab" data-material-tab="target" :aria-selected="mobile === 'target'" :class="{active:mobile==='target'}" @click="mobile='target'">{{ target?.ref.label || '目标' }}</button></nav>
      <main class="material-insert-columns">
        <section class="material-source-pane" :class="{'material-mobile-hidden':mobile!=='source'}" aria-label="待插入素材">
          <div class="material-fields"><button @click="placing = remaining.map(p => p.key)">全选定位</button><button :disabled="!placing.length" @click="locate(placing)">选择落点 · {{ placing.length }}</button><label class="material-check"><input v-model="enabled" type="checkbox" />启用新增条目</label></div>
          <div class="material-scroll">
            <details v-if="items[0].kind === 'preset'" class="material-card"><summary>批量前后文本</summary><label>条目前文本<textarea v-model="prefix" rows="2" aria-label="条目前文本"></textarea></label><label>条目后文本<textarea v-model="suffix" rows="2" aria-label="条目后文本"></textarea></label><label class="material-check"><input v-model="bulkAll" type="checkbox" />本次全部，包含已插入</label><button @click="applyText">应用前后文本</button></details>
            <p v-if="!remaining.length">素材已放入目标列表，可在目标页移回。</p>
            <article v-for="p in remaining" :key="p.key" class="material-card" :data-part-key="p.key">
              <label class="material-check"><input v-model="placing" type="checkbox" :value="p.key" :aria-label="`定位 ${p.original.name}`" /><strong>{{ p.original.name }}</strong></label>
              <button class="material-position-label" :aria-label="`设置${p.original.name}的位置`" @click="locate([p.key])">{{ label(p.position) }}</button>
              <details v-if="items[0].kind === 'preset'"><summary>正文与变量</summary>
                <select v-model="p.mode" :aria-label="`${p.original.name} 插入方式`"><option value="keep">保留原样</option><option value="wrap" :disabled="!!scanVariables(p.original.content).macros.length">整段存入变量</option><option value="reminder" :disabled="!!scanVariables(p.original.content).macros.length">保留正文＋引用短句</option></select>
                <div v-if="p.mode !== 'keep'" class="material-fields"><label>变量名<input v-model="p.name" :aria-label="`${p.original.name} 变量名`" /></label><label>范围<select v-model="p.scope"><option value="local">聊天变量</option><option value="global">全局变量</option></select></label></div>
                <label v-if="p.mode === 'reminder'">引用短句<textarea v-model="p.reminder" rows="3" :aria-label="`${p.original.name} 引用短句`"></textarea></label><pre>{{ p.original.content }}</pre>
              </details>
              <details v-else><summary>正则参数</summary><RegexFields :raw="p.original.raw" /></details>
              <button class="material-remove" @click="p.selected = false; placing = placing.filter(k => k !== p.key)">移出本次</button>
            </article>
            <details v-if="variables.length" class="material-variable-options" open><summary>变量 · {{ bindings.length }}</summary>
              <div v-for="b in bindings" :key="b.key" class="material-variable-row">
                <strong>{{ b.to }}<small v-if="b.scope === 'global'"> · 全局</small></strong>
                <div class="material-fields"><label class="material-check"><input v-model="b.initialize" type="checkbox" :aria-label="`初始化 ${b.from}`" />补初始化</label><label class="material-check"><input v-model="b.reference" type="checkbox" :aria-label="`引用 ${b.from}`" />插入引用</label></div>
                <label v-if="b.initialize">初始值<input v-model="b.initial" :aria-label="`${b.from} 初始值`" /></label>
                <details><summary>改名</summary><input v-model="b.to" :aria-label="`${b.from} 目标变量名`" @input="b.share = b.to === b.from" /><label v-if="conflict(b)" class="material-check"><input v-model="b.share" type="checkbox" :aria-label="`共用 ${b.to}`" />共用已有变量</label></details>
              </div>
              <div class="material-fields"><button @click="selectTask('init')">初始化位置</button><button @click="selectTask('reference')">引用位置</button></div>
              <small v-if="initId">初始化 · {{ initId === '__new' ? '新建条目' : target?.entries.find(e => e.id === initId)?.name }}</small>
              <label v-if="initId === '__new'" class="material-check"><input v-model="initEnabled" type="checkbox" />启用初始化条目</label>
              <small v-if="referenceId">引用 · {{ target?.entries.find(e => e.id === referenceId)?.name }}</small>
            </details>
          </div>
        </section>
        <section class="material-target-pane" :class="{'material-mobile-hidden':mobile!=='target'}" aria-label="目标条目列表">
          <nav class="material-fields"><button :class="{active:task==='position'}" @click="task='position'">插入位置</button><button v-if="variables.length" :class="{active:task==='init'}" @click="task='init'">初始化</button><button v-if="variables.length" :class="{active:task==='reference'}" @click="task='reference'">引用</button></nav>
          <small v-if="task === 'position'">{{ placing.length ? `为选中的 ${placing.length} 条选择落点` : '在素材页选择要定位的条目' }}</small>
          <small v-if="loading">读取中…</small>
          <template v-else-if="target && !loadFailed">
            <template v-if="task === 'reference' && referenceEditing && referenceId">
              <div class="material-fields"><button @click="referenceEditing=false">返回条目列表</button><strong>{{ target.entries.find(e => e.id === referenceId)?.name }}</strong></div>
              <label class="material-reference-editor">正文<textarea ref="referenceArea" v-model="referenceText" rows="12" aria-label="引用位置正文"></textarea></label>
              <div class="material-fields"><button @click="insertReferences">在光标处插入引用</button><button @click="mobile='source'">返回素材</button></div>
            </template>
            <EntryPicker v-else :doc="task === 'position' ? displayTarget! : target" :mode="task === 'position' ? 'position' : 'entry'" :selected="task === 'init' ? initId : referenceId" :allow-new="task === 'init'" :grouping="grouping" :staged="task === 'position' ? stagedIds : undefined" @position="place" @choose="choose" @remove="returnMaterial" />
          </template>
        </section>
      </main>
    </template>
    <div v-else class="material-scroll">
      <strong>{{ target?.ref.label }}</strong><ul><li v-for="line in changes?.lines" :key="line">{{ line }}</li></ul>
      <p v-for="warning in preview.warnings" :key="warning" class="material-warning">{{ warning }}</p>
      <details v-for="entry in preview.doc.entries.filter(e => preview!.added.includes(e.id) || target?.entries.find(old => old.id === e.id)?.content !== e.content)" :key="entry.id"><summary>{{ entry.name }} · {{ entry.enabled ? '启用' : '关闭' }}</summary><pre>{{ entry.content }}</pre><fieldset v-if="items[0].kind === 'regex'" disabled><RegexFields :raw="entry.raw" /></fieldset></details>
      <small>加入草稿后，仍需在工坊保存。</small>
    </div>
    <footer><button v-if="preview" @click="preview=null; problem=''">返回</button><button v-else @click="emit('close')">取消</button><button v-if="!preview" class="primary" :disabled="loading || loadFailed || !placed.length || !!stageError" @click="review">预览改动</button><button v-else class="primary" @click="apply">加入草稿</button></footer>
  </section>
</template>
<style>
#prw-mount .material-insert{width:min(1260px,100%)}
#prw-mount .material-insert-columns{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:14px;flex:1;min-height:0;min-width:0}
#prw-mount :is(.material-source-pane,.material-target-pane){display:flex;flex-direction:column;gap:9px;min-width:0;min-height:0}
#prw-mount .material-target-pane{border-left:1px solid var(--prw-border);padding-left:14px}
#prw-mount .material-mobile-tabs{display:none}
#prw-mount .material-position-label{text-align:left;overflow-wrap:anywhere;color:var(--prw-accent)}
#prw-mount .material-insert details>summary{cursor:pointer;padding:3px 0}
#prw-mount .material-insert details[open]>:not(summary){margin-top:8px}
#prw-mount .material-remove{align-self:flex-end;font-size:11px!important}
#prw-mount .material-variable-options{border-top:1px solid var(--prw-border);padding-top:8px}
#prw-mount .material-variable-row{display:flex;flex-direction:column;gap:6px;border-bottom:1px solid var(--prw-border);padding:7px 0}
#prw-mount .material-variable-row>details{font-size:11px}
#prw-mount .material-reference-editor{flex:1;min-height:0}
#prw-mount .material-reference-editor textarea{flex:1;min-height:120px}
@media(max-width:760px){#prw-mount .material-insert-columns{display:flex;flex-direction:column;gap:0}#prw-mount :is(.material-source-pane,.material-target-pane){flex:1}#prw-mount .material-target-pane{border:0;padding:0}#prw-mount .material-insert .material-mobile-hidden{display:none!important}#prw-mount .material-mobile-tabs{display:flex;gap:6px}#prw-mount .material-mobile-tabs>button{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
</style>
