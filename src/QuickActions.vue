<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { clone, rangeMembers } from './core';
import { QuickOperations, sameResource } from './quick-operations';
import type { GroupChoice, QuickSource } from './quick-operations';
import type { Host, Resource, WorkDocument } from './types';

const props = defineProps<{ host: Host; guard: (ref: Resource) => void; changed: (refs: Resource[]) => void }>();
const operations = new QuickOperations(props.host, props.guard, props.changed);
const stage = ref<'' | 'targets' | 'groups' | 'name' | 'confirm' | 'error'>('');
const dialog = ref<HTMLDialogElement>();
const busy = ref(false), message = ref(''), notice = ref(''), query = ref('');
const action = ref<'copy' | 'move'>('copy');
const sources = ref<QuickSource[]>([]), targets = ref<Resource[]>([]);
const target = ref<Resource>(), targetDoc = ref<WorkDocument>();
const pending = ref<{ ref: Resource; id: string }>();
const groupName = ref(''), provider = ref(''), endpoint = ref('');
const destructive = ref<{ ref: Resource; id: string; detach: boolean; label: string }>();
let trigger: HTMLElement | undefined, timer: ReturnType<typeof setTimeout> | undefined;
const plans = computed(() => targetDoc.value ? operations.plans(targetDoc.value) : []);
const filteredTargets = computed(() => targets.value.filter(r => r.label.toLowerCase().includes(query.value.toLowerCase())));
const groupCount = computed(() => {
  if (!pending.value || !targetDoc.value || !endpoint.value) return 0;
  return rangeMembers(targetDoc.value, pending.value.id, endpoint.value).length;
});
function toast(value: string) {
  notice.value = value; clearTimeout(timer);
  timer = setTimeout(() => { notice.value = ''; }, 2800);
}
async function show(value: typeof stage.value) {
  stage.value = value;
  await nextTick();
  if (dialog.value && !dialog.value.open) dialog.value.showModal();
}
function close() {
  if (busy.value) return;
  stage.value = '';
  if (trigger?.isConnected) trigger.focus();
}
function clearRange() {
  pending.value = undefined;
  document.querySelectorAll('.prw-range-start').forEach(e => e.classList.remove('prw-range-start'));
}
function reset() { if (!busy.value) stage.value = ''; clearRange(); }
async function run(fn: () => Promise<unknown>, text: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    await fn();
    stage.value = '';
    for (const source of sources.value) for (const id of source.ids) {
      document.querySelectorAll<HTMLElement>('#regex_container .regex-script-label').forEach(row => {
        if ((row.dataset.regexScriptId || row.id) !== id) return;
        if (row.dataset.regexType && row.dataset.regexType !== source.ref.scope) return;
        const checkbox = row.querySelector<HTMLInputElement>('.regex_bulk_checkbox');
        if (checkbox?.checked) { checkbox.checked = false; checkbox.dispatchEvent(new Event('change', { bubbles: true })); }
      });
    }
    toast(text);
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error);
    await show('error');
  } finally { busy.value = false; }
}
async function transfer(value: QuickSource[], mode: 'copy' | 'move', choose: boolean, element: HTMLElement) {
  if (busy.value || !value.length) return;
  trigger = element; sources.value = clone(value); action.value = mode;
  query.value = ''; targetDoc.value = undefined;
  if (!choose) {
    await run(() => operations.transfer(value, value[0].ref, mode), `已${mode === 'copy' ? '复制' : '移动'} ${value.reduce((n, s) => n + s.ids.length, 0)} 条`);
    return;
  }
  targets.value = operations.targets(value[0].ref);
  await show('targets');
}
async function execute(ref: Resource, choice?: GroupChoice) {
  await run(() => operations.transfer(sources.value, ref, action.value, choice), action.value === 'copy' ? '已复制' : '已移动');
}
async function groups(ref: Resource) {
  try { target.value = ref; targetDoc.value = await operations.load(ref); await show('groups'); }
  catch (error) { message.value = String(error instanceof Error ? error.message : error); await show('error'); }
}
async function group(ref: Resource, id: string, element: HTMLElement) {
  if (busy.value) return;
  trigger = element;
  sources.value = [];
  if (!pending.value || !sameResource(pending.value.ref, ref)) {
    clearRange(); pending.value = { ref: clone(ref), id };
    element.closest('.regex-script-label,[data-pm-identifier]')?.classList.add('prw-range-start');
    return;
  }
  try {
    targetDoc.value = await operations.load(ref); endpoint.value = id;
    rangeMembers(targetDoc.value, pending.value.id, id);
    groupName.value = '';
    const external = targetDoc.value.sources.filter(s => s.provider !== 'own');
    provider.value = targetDoc.value.state.groups.length ? 'own' : external.length === 1 ? external[0].provider : external.length ? '' : 'own';
    await show('name');
  } catch (error) { message.value = String(error instanceof Error ? error.message : error); await show('error'); }
}
async function finishGroup() {
  if (!pending.value || !groupName.value.trim() || !provider.value) return;
  const start = pending.value;
  await run(async () => {
    await operations.group(start.ref, start.id, endpoint.value, groupName.value, provider.value as GroupChoice['provider']);
    clearRange();
  }, '已分组');
}
async function erase(ref: Resource, id: string, detach: boolean, label: string, element: HTMLElement) {
  sources.value = [];
  trigger = element; destructive.value = { ref: clone(ref), id, detach, label };
  await show('confirm');
}
async function finishErase() {
  const item = destructive.value;
  if (item) await run(() => operations.erase(item.ref, [item.id], item.detach), item.detach ? '已移出列表' : '已删除');
}
onBeforeUnmount(() => { clearTimeout(timer); clearRange(); });
defineExpose({ transfer, group, erase, reset, collapse: (ref: Resource, id: string) => run(() => operations.collapse(ref, id), '已更新分组'), isRange: (ref: Resource) => !!pending.value && sameResource(pending.value.ref, ref) });
</script>

<template>
  <div v-if="pending" class="prw-native-range" role="status">选择分组终点 <button @click="clearRange">取消</button></div>
  <div v-if="notice" class="prw-quick-notice" role="status">{{ notice }}</div>
  <dialog v-if="stage" ref="dialog" class="prw-quick-dialog" :aria-label="stage === 'confirm' ? (destructive?.detach ? '从列表移除' : '删除条目') : stage === 'name' ? '建立分组' : stage === 'error' ? '操作未完成' : action === 'copy' ? '复制到' : '移动到'" @cancel.prevent="close" @pointerdown.stop @mousedown.stop @click.stop>
    <header>
      <strong>{{ stage === 'confirm' ? (destructive?.detach ? '从列表移除' : '删除条目') : stage === 'name' ? '建立分组' : stage === 'error' ? '操作未完成' : action === 'copy' ? '复制到' : '移动到' }}</strong>
      <button aria-label="关闭快捷操作" :disabled="busy" @click="close">✕</button>
    </header>
    <template v-if="stage === 'targets'">
      <nav><button :class="{active:action==='copy'}" @click="action='copy'">复制</button><button :class="{active:action==='move'}" @click="action='move'">移动</button></nav>
      <input v-model="query" type="search" aria-label="搜索目标" placeholder="搜索目标" />
      <div class="quick-list">
        <div v-for="ref in filteredTargets" :key="ref.key" class="quick-target">
          <button :disabled="busy" @click="execute(ref)">{{ ref.label }}</button>
          <button :disabled="busy" :aria-label="`选择${ref.label}分组`" title="选择分组" @click="groups(ref)">›</button>
        </div>
      </div>
    </template>
    <template v-else-if="stage === 'groups'">
      <button @click="show('targets')">‹ {{ target?.label }}</button>
      <div class="quick-list">
        <section v-for="plan in plans" :key="plan.provider">
          <small>{{ plan.label }}</small>
          <button :disabled="busy" @click="execute(target!, {provider:plan.provider,id:''})">未分组</button>
          <button v-for="g in plan.groups" :key="g.id" :disabled="busy" @click="execute(target!, {provider:plan.provider,id:g.id})">{{ g.name }}</button>
        </section>
      </div>
    </template>
    <form v-else-if="stage === 'name'" @submit.prevent="finishGroup">
      <small>{{ groupCount }} 条</small>
      <label v-if="plans.length > 1">分组方案<select v-model="provider" aria-label="分组方案"><option disabled value="">选择方案</option><option v-for="plan in plans" :key="plan.provider" :value="plan.provider">{{ plan.label }}</option></select></label>
      <label>组名<input v-model="groupName" required autofocus /></label>
      <footer><button type="button" :disabled="busy" @click="close">取消</button><button :disabled="busy || !provider || !groupName.trim()" type="submit">{{ busy ? '处理中…' : '确定' }}</button></footer>
    </form>
    <template v-else-if="stage === 'confirm'">
      <p>{{ destructive?.label }}</p>
      <footer><button :disabled="busy" @click="close">取消</button><button class="danger" :disabled="busy" @click="finishErase">{{ busy ? '处理中…' : '确定' }}</button></footer>
    </template>
    <template v-else><p role="alert">{{ message }}</p><button @click="close">关闭</button></template>
  </dialog>
</template>

<style scoped>
.prw-quick-dialog{box-sizing:border-box;width:min(350px,calc(100vw - 24px));max-height:80dvh;padding:14px;border:1px solid var(--prw-border);border-radius:12px;background:var(--prw-bg);color:var(--prw-text);box-shadow:0 12px 40px var(--prw-shadow);font:14px/1.4 system-ui}
.prw-quick-dialog::backdrop{background:var(--prw-shade)}
.prw-quick-dialog *{box-sizing:border-box}
.prw-quick-dialog header,.prw-quick-dialog nav,.prw-quick-dialog footer,.quick-target{display:flex;align-items:center;gap:7px}
.prw-quick-dialog header{justify-content:space-between;margin-bottom:12px}.prw-quick-dialog footer{justify-content:flex-end;margin-top:12px}
.prw-quick-dialog button,.prw-quick-dialog input,.prw-quick-dialog select{font:inherit;color:inherit;min-width:0;border:1px solid var(--prw-border);border-radius:6px;background:var(--prw-surface);padding:7px 9px;box-shadow:none;text-shadow:none}
.prw-quick-dialog button{cursor:pointer}.prw-quick-dialog button:hover,.prw-quick-dialog .active{background:var(--prw-active)}.prw-quick-dialog button:disabled{opacity:.4;cursor:default}
.prw-quick-dialog input,.prw-quick-dialog select{width:100%}.prw-quick-dialog input[type=search]{margin:10px 0}.prw-quick-dialog label{display:grid;gap:5px;margin-top:10px}.prw-quick-dialog small{color:var(--prw-muted)}
.quick-list{max-height:50dvh;overflow:auto;overscroll-behavior:contain}.quick-target{gap:3px;margin:4px 0}.quick-target button:first-child{flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.quick-target button:last-child{flex:0 0 30px}
.quick-list section{display:grid;gap:4px;margin-top:8px}.quick-list section>button{text-align:left}.danger{color:var(--prw-danger)!important}
.prw-native-range,.prw-quick-notice{position:fixed;z-index:100210;bottom:65px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 24px);display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--prw-border);border-radius:8px;background:var(--prw-bg);color:var(--prw-text);box-shadow:0 6px 20px var(--prw-shadow);font-size:13px}
.prw-native-range button{font:inherit;padding:2px 6px;background:var(--prw-surface);color:inherit;border:1px solid var(--prw-border);border-radius:4px;cursor:pointer}
</style>
