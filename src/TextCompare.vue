<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Entry, Side } from './types';
const props = defineProps<{ left?: Entry; right?: Entry; names: Record<Side, string>; initialPage: Side }>();
const emit = defineEmits<{ close: []; edit: [side: Side] }>();
const dialog = ref<HTMLDialogElement>(), page = ref<Side>(props.initialPage);
const parts = ref<[number, string][] | null>(null);
const sides = computed(() => (['left', 'right'] as Side[]).filter(side => props[side]));
const columns = computed(() => Object.fromEntries(sides.value.map(side => [side,
  parts.value ? parts.value.filter(([op]) => side === 'left' ? op <= 0 : op >= 0) : [[0, props[side]!.content]],
])) as Record<Side, [number, string][]>);
let timer: ReturnType<typeof setTimeout> | undefined;
let previous: HTMLElement | null = null;
onMounted(async () => {
  previous = document.activeElement as HTMLElement;
  if (!props[page.value]) page.value = sides.value[0];
  await nextTick(); dialog.value?.showModal();
  timer = setTimeout(() => {
    const Diff = window.SillyTavern?.libs?.DiffMatchPatch;
    if (!Diff || !props.left || !props.right || props.left.content.length + props.right.content.length > 100_000) return;
    const diff = new Diff(); diff.Diff_Timeout = 0.05;
    const result = diff.diff_main(props.left.content, props.right.content);
    diff.diff_cleanupSemantic(result); parts.value = result;
  }, 0);
});
onBeforeUnmount(() => { clearTimeout(timer); dialog.value?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); });
</script>
<template>
  <dialog ref="dialog" class="prw-text-reader" :aria-label="sides.length === 2 ? '正文对比' : '条目正文'" @cancel.prevent="emit('close')" @keydown.esc.stop.prevent="emit('close')">
    <header><strong>{{ sides.length === 2 ? '正文对比' : '条目正文' }}</strong><button autofocus aria-label="关闭正文对比" @click="emit('close')">✕</button></header>
    <nav v-if="sides.length === 2" class="reader-tabs">
      <button v-for="side in sides" :key="side" :class="{active:page===side}" :title="names[side]" @click="page=side">{{ names[side] }}</button>
    </nav>
    <main :class="{single:sides.length===1}">
      <section v-for="side in sides" :key="side" :data-side="side" :class="{'reader-hidden':page!==side}">
        <div class="reader-heading"><div><small :title="names[side]">{{ names[side] }}</small><strong :title="props[side]!.name">{{ props[side]!.name }}</strong></div><button @click="emit('edit',side)">编辑</button></div>
        <pre tabindex="0"><template v-for="([op,text],i) in columns[side]" :key="i"><mark v-if="op" :class="op>0?'added':'removed'">{{ text }}</mark><span v-else>{{ text }}</span></template></pre>
      </section>
    </main>
  </dialog>
</template>
<style scoped>
.prw-text-reader{position:fixed;inset:16px;margin:auto;width:min(1600px,calc(100vw - 32px));height:calc(100dvh - 32px);max-width:none;max-height:none;padding:0;border:1px solid var(--prw-border);border-radius:12px;background:var(--prw-bg);color:var(--prw-text);box-sizing:border-box;overflow:hidden;box-shadow:0 20px 80px var(--prw-shadow)}
.prw-text-reader[open]{display:flex;flex-direction:column}.prw-text-reader::backdrop{background:var(--prw-shade);backdrop-filter:blur(5px)}
.prw-text-reader>header,.reader-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid var(--prw-border)}
.prw-text-reader button{flex:none;margin:0;font:inherit;border:1px solid var(--prw-border);border-radius:6px;padding:5px 10px;color:var(--prw-text);background:var(--prw-surface);cursor:pointer}
.prw-text-reader>main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);flex:1;min-height:0}.prw-text-reader>main.single{grid-template-columns:minmax(0,1fr)}
.prw-text-reader section{display:flex;flex-direction:column;min-height:0;min-width:0}.prw-text-reader section+section{border-left:1px solid var(--prw-border)}
.reader-heading>div{display:grid;gap:4px;min-width:0}.reader-heading strong,.reader-heading small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.reader-heading small{font-size:12px;color:var(--prw-muted)}
.prw-text-reader pre{margin:0;padding:20px;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;font:14px/1.75 ui-monospace,Consolas,monospace;color:var(--prw-text);background:transparent;border:0}
.prw-text-reader mark{color:inherit;background:color-mix(in srgb,var(--prw-exact) 24%,transparent)}.prw-text-reader mark.removed{background:color-mix(in srgb,var(--prw-danger) 22%,transparent)}
.reader-tabs{display:none}
@media(max-width:760px){.prw-text-reader{inset:0;width:100vw;height:100dvh;border-radius:0}.prw-text-reader>main{display:flex}.prw-text-reader section{flex:1}.prw-text-reader section.reader-hidden{display:none}.prw-text-reader section+section{border-left:0}.reader-tabs{display:flex;gap:5px;padding:6px 10px;border-bottom:1px solid var(--prw-border)}.reader-tabs button{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.reader-tabs button.active{border-color:var(--prw-accent);background:var(--prw-active)}.prw-text-reader pre{padding:14px;font-size:13px}.reader-heading{padding:10px}.prw-text-reader>header{padding:10px}}
</style>
