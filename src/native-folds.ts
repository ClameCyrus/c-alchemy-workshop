import type { Resource } from './types';

const KEY = 'c-alchemy-workshop:native-folds:v1';
let values: Map<string, boolean> | undefined;
const prefix = (ref: Resource) => JSON.stringify([ref.kind, ref.scope, ref.name || ref.avatar || 'global']) + ':';
function data() {
  if (!values) {
    values = new Map();
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (Array.isArray(stored)) for (const pair of stored.slice(-2048))
        if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'boolean') values.set(pair[0], pair[1]);
    } catch { /* A damaged browser preference must not block the native list. */ }
  }
  return values;
}
export function nativeFolds(ref: Resource) {
  const start = prefix(ref);
  return Object.fromEntries([...data()].filter(([key]) => key.startsWith(start)).map(([key, value]) => [key.slice(start.length), value]));
}
export function saveNativeFold(ref: Resource, id: string, collapsed: boolean) {
  const map = data(), key = prefix(ref) + id;
  map.delete(key); map.set(key, collapsed);
  while (map.size > 2048) map.delete(map.keys().next().value!);
  try { localStorage.setItem(KEY, JSON.stringify([...map])); }
  catch (error) { console.warn('[Cの炼金工坊] 无法保存折叠偏好', error); }
}
