<script setup lang="ts">
import type { Raw } from './types';
const props = defineProps<{ raw: Raw }>();
function placement(value: number, checked: boolean) {
  const current = Array.isArray(props.raw.placement) ? props.raw.placement : [];
  props.raw.placement = checked ? [...new Set([...current, value])] : current.filter((p: number) => p !== value);
}
</script>
<template>
  <div class="regex-fields">
    <label>查找<textarea v-model="raw.findRegex" rows="3" aria-label="正则查找"></textarea></label>
    <label>替换<textarea v-model="raw.replaceString" rows="5" aria-label="正则替换"></textarea></label>
    <div class="library-fields">
      <label>最小深度<input :value="raw.minDepth" type="number" aria-label="正则最小深度" @input="raw.minDepth = ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value)" /></label>
      <label>最大深度<input :value="raw.maxDepth" type="number" aria-label="正则最大深度" @input="raw.maxDepth = ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value)" /></label>
      <label>替换宏<select :value="raw.substituteRegex ?? 0" aria-label="正则替换宏" @change="raw.substituteRegex = Number(($event.target as HTMLSelectElement).value)"><option :value="0">不替换</option><option :value="1">替换</option><option :value="2">转义替换</option></select></label>
    </div>
    <div class="library-fields"><label class="library-check"><input v-model="raw.markdownOnly" type="checkbox" />仅显示</label><label class="library-check"><input v-model="raw.promptOnly" type="checkbox" />仅提示词</label><label class="library-check"><input v-model="raw.runOnEdit" type="checkbox" />编辑时运行</label></div>
    <div class="library-fields"><label v-for="[value, label] in [[1,'用户'],[2,'AI'],[3,'命令'],[5,'世界书'],[6,'推理']]" :key="value" class="library-check"><input type="checkbox" :checked="raw.placement?.includes?.(value) || false" :aria-label="`正则作用于${label}`" @change="placement(Number(value), ($event.target as HTMLInputElement).checked)" />{{ label }}</label></div>
    <label>裁剪文本<textarea :value="(raw.trimStrings || []).join('\n')" rows="2" aria-label="正则裁剪文本" @input="raw.trimStrings = ($event.target as HTMLTextAreaElement).value.split('\n').filter(Boolean)"></textarea></label>
  </div>
</template>
<style>
#prw-mount .regex-fields{display:flex;flex-direction:column;gap:10px;min-width:0}
</style>
