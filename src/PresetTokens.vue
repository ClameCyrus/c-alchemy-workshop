<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { pausedMembers } from './core';
import type { Host, WorkDocument } from './types';

const props = defineProps<{ doc: WorkDocument; host: Host; grouping: boolean }>();
const requested = ref(false), pending = ref(false);
const total = ref<number>(), problem = ref('');
const description = '统计启用条目的正文，使用酒馆当前 tokenizer。运行时展开的宏、世界书和聊天内容另计。';
const texts = computed(() => {
  const paused = props.grouping ? pausedMembers(props.doc.state) : new Set<string>();
  return props.doc.entries.filter(entry => entry.enabled && entry.content && !entry.raw.marker && !paused.has(entry.id))
    .map(entry => entry.content);
});
let timer: ReturnType<typeof setTimeout> | undefined;
let request = 0;

function schedule(delay = 0) {
  const ticket = ++request;
  clearTimeout(timer);
  requested.value = pending.value = true;
  problem.value = '';
  const contents = texts.value;
  timer = setTimeout(async () => {
    let failed = false;
    try {
      const count = props.host.countTokens?.bind(props.host);
      if (!count) throw new Error('当前酒馆没有提供 Token 计数');
      const occurrences = new Map<string, number>();
      for (const text of contents) occurrences.set(text, (occurrences.get(text) ?? 0) + 1);
      const queue = [...occurrences.entries()].values();
      let sum = 0;
      async function countRemaining() {
        for (const [text, frequency] of queue) {
          if (failed || ticket !== request) return;
          const result = await count!(text);
          if (!Number.isFinite(result) || result < 0) throw new Error('酒馆 Token 计数返回无效结果');
          sum += result * frequency;
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, occurrences.size) }, countRemaining));
      if (ticket === request) total.value = sum;
    } catch (error) {
      failed = true;
      if (ticket === request) {
        total.value = undefined;
        problem.value = error instanceof Error ? error.message : '酒馆 Token 计数失败';
      }
    } finally {
      if (ticket === request) pending.value = false;
    }
  }, delay);
}

watch(texts, (next, previous) => {
  if (requested.value && (next.length !== previous.length || next.some((text, index) => text !== previous[index]))) schedule(150);
});
onBeforeUnmount(() => { request++; clearTimeout(timer); });
</script>

<template>
  <button type="button" class="preset-tokens" :aria-busy="pending" :title="problem || description"
    :aria-label="problem ? 'Token 统计失败，点击重试' : pending ? '正在统计启用条目的 Token' : total === undefined ? '统计启用条目的 Token' : '启用条目 ' + total + ' Token，点击重新统计'"
    @click="schedule()">
    <span aria-live="polite">{{ problem ? 'Token 重试' : pending ? 'Token…' : total === undefined ? 'Token' : total.toLocaleString() + ' Token' }}</span>
  </button>
</template>
