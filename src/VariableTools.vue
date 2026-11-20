<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { spliceVariableText, variableMacro, scanVariables, textareaOffset, textSelection, type IndexedVariable, type VariableScope } from './variables';

const props = defineProps<{ area?: HTMLTextAreaElement; variables: IndexedVariable[] }>();
const content = defineModel<string>({ required: true });
const mode = ref<'get' | 'set' | 'missing'>();
const scope = ref<VariableScope>('local');
const name = ref(''), problem = ref('');
let selection = { start: 0, end: 0 };
const candidates = computed(() => mode.value === 'missing'
  ? props.variables.filter(variable => variable.writes.length && !variable.reads.length)
  : props.variables.filter(variable => variable.scope === scope.value));
const shortcuts = [
  { action: 'set', scope: 'local', label: 'setvar' },
  { action: 'get', scope: 'local', label: 'getvar' },
  { action: 'set', scope: 'global', label: 'setglobalvar' },
  { action: 'get', scope: 'global', label: 'getglobalvar' },
] as const;
function open(action: typeof mode.value, target: VariableScope = 'local') {
  if (mode.value === action && scope.value === target) { mode.value = undefined; return; }
  mode.value = action;
  scope.value = target;
  name.value = '';
  problem.value = '';
  selection = textSelection(content.value, props.area);
}
function insert(variableName: string, target: VariableScope) {
  try {
    const value = mode.value === 'set' ? content.value.slice(selection.start, selection.end) : undefined;
    const macro = variableMacro(target, variableName.trim(), value);
    const scan = scanVariables(macro);
    if (scan.macros[0]?.end !== macro.length || scan.issues.some(issue => issue.includes('未闭合')))
      throw new Error('选区中的宏未闭合，请重新选择正文');
    content.value = spliceVariableText(content.value, selection.start, selection.end, macro);
    const end = textareaOffset(content.value, selection.start + macro.length);
    mode.value = undefined;
    nextTick(() => {
      props.area?.setSelectionRange(end, end);
      if (matchMedia('(pointer: fine)').matches) props.area?.focus({ preventScroll: true });
    });
  } catch (error) { problem.value = (error as Error).message; }
}
</script>

<template>
  <div class="variable-tools">
    <div class="variable-shortcuts">
      <button v-for="item in shortcuts" :key="item.label" type="button" :aria-expanded="mode === item.action && scope === item.scope"
        @pointerdown.prevent @click="open(item.action, item.scope)">{{ item.label }}</button>
      <button type="button" :aria-expanded="mode === 'missing'" @pointerdown.prevent @click="open('missing')">未引用</button>
    </div>
    <div v-if="mode" class="variable-tool-form" @keydown.esc.stop.prevent="mode = undefined">
      <div v-if="mode !== 'missing'" class="variable-shortcuts">
        <input v-model="name" aria-label="变量名" placeholder="变量名" @keydown.enter.stop.prevent="insert(name, scope)" />
        <button type="button" :disabled="!name.trim()" @click="insert(name, scope)">插入</button>
      </div>
      <div v-if="candidates.length" class="variable-candidates">
        <button v-for="variable in candidates.filter(v => !name || v.name.toLowerCase().includes(name.toLowerCase()))" :key="variable.key" type="button"
          @click="insert(variable.name, variable.scope)">{{ variable.name }}<small v-if="mode === 'missing' && variable.scope === 'global'"> · 全局</small></button>
      </div>
      <small v-else-if="mode === 'missing'">本预设的 set 都有对应的 get。</small>
      <small v-if="problem" role="alert">{{ problem }}</small>
    </div>
  </div>
</template>

<style>
#prw-panel .variable-tools, #prw-panel .variable-tool-form { display:grid; gap:6px; }
#prw-panel .variable-shortcuts { display:flex; flex-wrap:wrap; gap:4px; }
#prw-panel .variable-shortcuts input { min-width:0; flex:1; }
#prw-panel .variable-shortcuts button { padding:4px 6px; }
#prw-panel .variable-candidates { display:flex; flex-wrap:wrap; gap:4px; max-height:95px; overflow:auto; }
#prw-panel .variable-candidates button { overflow-wrap:anywhere; min-width:0; }
</style>
