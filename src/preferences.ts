import { z } from 'zod';

const View = z.object({
  left: z.string().default(''), right: z.string().default(''),
  dual: z.boolean().default(true), filter: z.string().default('all'),
  relation: z.string().default('all'), unused: z.boolean().default(false),
  search: z.object({ left: z.string(), right: z.string() }).default({ left: '', right: '' }),
  groups: z.object({ left: z.string(), right: z.string() }).default({ left: '', right: '' }),
}).prefault({});
const Color = z.string().regex(/^#[0-9a-f]{6}$/i);
const Preferences = z.object({
  kind: z.enum(['preset', 'regex']).default('preset'),
  operation: z.enum(['browse', 'drag', 'insert']).default('browse'),
  transfer: z.enum(['copy', 'move']).default('copy'),
  page: z.enum(['left', 'right']).default('left'),
  views: z.object({ preset: View, regex: View }).prefault({}),
  appearance: z.object({
    mode: z.enum(['theme', 'custom']).default('theme'),
    background: Color.default('#f0fbff'), text: Color.default('#24465c'),
    muted: Color.default('#3f6e86'), accent: Color.default('#0b5577'),
    border: Color.default('#8dc6dd'),
  }).prefault({}),
}).prefault({});
export type PreferencesState = z.infer<typeof Preferences>;
const KEY = 'c-alchemy-workshop:ui:v1';
export function readPreferences(): PreferencesState {
  try { return Preferences.parse(JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch { return Preferences.parse({}); }
}
export function writePreferences(value: PreferencesState) {
  try { localStorage.setItem(KEY, JSON.stringify(value)); }
  catch (error) { console.warn('[Cの炼金工坊] 无法保存界面偏好', error); }
}
export function applyAppearance(value: PreferencesState['appearance']) {
  for (const [field, token] of Object.entries({ background: 'bg', text: 'text', muted: 'muted', accent: 'accent', border: 'border' })) {
    const key = `--prw-${token}`;
    if (value.mode === 'custom') document.documentElement.style.setProperty(key, value[field as keyof typeof value]);
    else document.documentElement.style.removeProperty(key);
  }
}
