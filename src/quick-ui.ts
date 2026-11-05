import { createApp, markRaw } from 'vue';
import QuickActions from './QuickActions.vue';
import type { QuickSource } from './quick-operations';
import type { Host, Resource } from './types';
import { nativeSurface } from './native-surface';

interface QuickController {
  transfer(sources: QuickSource[], action: 'copy' | 'move', choose: boolean, trigger: HTMLElement): void;
  group(ref: Resource, id: string, trigger: HTMLElement): void;
  erase(ref: Resource, id: string, detach: boolean, label: string, trigger: HTMLElement): void;
  reset(): void;
  isRange(ref: Resource): boolean;
  groupEnabled(ref: Resource, id: string, enabled: boolean): Promise<void>;
  entryEnabled(ref: Resource, id: string, enabled: boolean): Promise<void>;
  fail(error: unknown): Promise<void>;
}
export function createQuickUI(host: Host, guard: (ref: Resource) => void, changed: (refs: Resource[]) => void) {
  const root = document.createElement('div'); root.id = 'prw-quick-root'; document.body.append(root);
  const app = createApp(QuickActions, { host: markRaw(host), guard, changed });
  const vm = app.mount(root) as unknown as QuickController;
  const place = (trigger: HTMLElement) => { nativeSurface(trigger).append(root); };
  return {
    transfer(sources: QuickSource[], action: 'copy' | 'move', choose: boolean, trigger: HTMLElement) {
      place(trigger); vm.transfer(sources, action, choose, trigger);
    },
    group(ref: Resource, id: string, trigger: HTMLElement) { place(trigger); vm.group(ref, id, trigger); },
    erase(ref: Resource, id: string, detach: boolean, label: string, trigger: HTMLElement) {
      place(trigger); vm.erase(ref, id, detach, label, trigger);
    },
    reset: () => vm.reset(), isRange: (ref: Resource) => vm.isRange(ref),
    groupEnabled: (ref: Resource, id: string, enabled: boolean) => vm.groupEnabled(ref, id, enabled),
    entryEnabled: (ref: Resource, id: string, enabled: boolean) => vm.entryEnabled(ref, id, enabled),
    fail: (error: unknown) => vm.fail(error),
    destroy() { app.unmount(); root.remove(); },
  };
}
