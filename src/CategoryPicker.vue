<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
const props = defineProps<{ folders: string[]; label: string; disabled?: boolean }>();
const value = defineModel<string>({ required: true });
const id = `prw-library-category-${useId()}`, root = ref<HTMLElement>(), menu = ref<HTMLElement>(), input = ref<HTMLInputElement>();
const open = ref(false), all = ref(true), active = ref(-1);
const options = computed(() => all.value || !value.value.trim() ? ['', ...props.folders] : props.folders.filter(name => name.toLowerCase().includes(value.value.trim().toLowerCase())));
function position() {
  if (!root.value || !menu.value) return;
  const rect = root.value.getBoundingClientRect(), below = innerHeight - rect.bottom - 8, above = rect.top - 8;
  const down = below >= 160 || below >= above, width = Math.min(rect.width, innerWidth - 16);
  Object.assign(menu.value.style, { width: `${width}px`, left: `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`,
    top: down ? `${rect.bottom + 4}px` : 'auto', bottom: down ? 'auto' : `${innerHeight - rect.top + 4}px`, maxHeight: `${Math.max(48, Math.min(240, down ? below : above))}px` });
}
function typed() { all.value = false; active.value = -1; if (open.value && !options.value.length) hide(); }
function hide() { menu.value?.hidePopover(); open.value = false; active.value = -1; }
function choose(name: string) { value.value = name; hide(); input.value?.focus(); }
async function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) { event.preventDefault(); event.stopPropagation(); hide(); return; }
  if (event.key === 'Enter' && open.value && active.value >= 0) { event.preventDefault(); choose(options.value[active.value]); return; }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  if (!open.value) { all.value = true; position(); menu.value?.showPopover(); }
  active.value = active.value < 0 ? (event.key === 'ArrowDown' ? 0 : options.value.length - 1) : (active.value + (event.key === 'ArrowDown' ? 1 : -1) + options.value.length) % options.value.length;
  await nextTick(); menu.value?.querySelector(`[data-option="${active.value}"]`)?.scrollIntoView({ block: 'nearest' });
}
function scrolled(event: Event) { if (!(event.target instanceof Node) || !menu.value?.contains(event.target)) hide(); }
onMounted(() => { window.addEventListener('scroll', scrolled, true); window.addEventListener('resize', hide); });
onBeforeUnmount(() => { hide(); window.removeEventListener('scroll', scrolled, true); window.removeEventListener('resize', hide); });
</script>
<template>
  <div ref="root" class="library-category-picker" @keydown="keydown">
    <input ref="input" v-model="value" role="combobox" :aria-label="label" aria-autocomplete="list" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="id" :aria-activedescendant="open && active >= 0 ? `${id}-${active}` : undefined" :disabled="disabled" autocomplete="off" placeholder="选择或输入分类" @input="typed" />
    <button type="button" :disabled="disabled" :popovertarget="id" :aria-label="`选择${label}`" aria-haspopup="listbox" :aria-expanded="open" @click="all=true; active=-1; position()">▾</button>
    <div :id="id" ref="menu" popover="auto" role="listbox" class="library-category-options" :aria-label="`${label}选项`" @beforetoggle="open = $event.newState === 'open'">
      <button v-for="(name,index) in options" :id="`${id}-${index}`" :key="name" type="button" role="option" :data-option="index" :aria-selected="value === name" :class="{active:index === active}" @click="choose(name)">{{ name || '未分类' }}</button>
    </div>
  </div>
</template>
<style>
#prw-mount .library-category-picker{position:relative;min-width:0;width:100%}
#prw-mount .library-category-picker>input{width:100%;height:36px}
#prw-mount #prw-panel .library-category-picker>button{position:absolute;right:0;top:0;width:36px;height:36px;--prw-button-padding:0;--prw-button-border-width:0;--prw-control-bg:transparent}
#prw-mount .library-category-options:popover-open{position:fixed;inset:auto;margin:0;display:flex;flex-direction:column;gap:2px;overflow:auto;padding:4px;box-sizing:border-box;overscroll-behavior:contain}
#prw-mount #prw-panel .library-category-options>button{flex:none;text-align:left;white-space:normal;overflow-wrap:anywhere;--prw-button-border-width:0;--prw-control-bg:transparent}
#prw-mount #prw-panel .library-category-options>button:is(:hover,.active){--prw-control-bg:var(--prw-active)}
@layer c-alchemy-workshop-protection{#prw-mount #prw-panel .library-category-picker>input{padding-right:40px!important}#prw-mount #prw-panel .library-category-options{background:var(--prw-bg)!important;color:var(--prw-text)!important;border:1px solid var(--prw-border)!important;border-radius:7px!important;box-shadow:0 8px 24px var(--prw-shadow)!important}}
</style>
