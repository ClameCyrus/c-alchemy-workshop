// Bai's preset view unmounts collapsed group rows. Ask its view state to retain them;
// do not change group.collapsed, stored settings, or recreate the rows ourselves.
export function retainNativeBodies(root: HTMLElement) {
  const saved = new Map<Record<string, boolean>, Map<string, { present: boolean; value: boolean }>>();
  let state: any;
  function sync() {
    const manager = (window as any).__baiBaiToolkitExtensionInstalled?.__baiBaiToolkitPresetVueListManager;
    if (root.id !== 'completion_prompt_manager_list' || manager?.root !== root || !Array.isArray(manager.state?.items)) return;
    state = manager.state;
    const mounted = state.mountedGroupBodies;
    if (!mounted || typeof mounted !== 'object') return;
    const before = saved.get(mounted) || new Map(); saved.set(mounted, before);
    for (const item of state.items) {
      if (item.type !== 'group' || !item.groupId) continue;
      const id = String(item.groupId);
      if (!before.has(id)) before.set(id, { present: Object.hasOwn(mounted, id), value: mounted[id] });
      if (manager.groupBodyUnmountTimers instanceof Map) {
        clearTimeout(manager.groupBodyUnmountTimers.get(id)); manager.groupBodyUnmountTimers.delete(id);
      }
      if (mounted[id] !== true) mounted[id] = true;
    }
  }
  return { sync, restore() {
    for (const [mounted, before] of saved) for (const [id, original] of before) {
      if (mounted[id] !== true) continue;
      if (state?.mountedGroupBodies === mounted && state.items?.some((item: any) => item.groupId === id && !item.collapsed)) continue;
      if (original.present) mounted[id] = original.value; else delete mounted[id];
    }
    saved.clear();
  } };
}
