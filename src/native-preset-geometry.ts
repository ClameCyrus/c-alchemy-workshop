/** jQuery's dimension hooks temporarily show hidden rows to measure them. For folded
 * groups this makes Sortable reflow the whole themed list twice per hidden item,
 * before sortstart even fires. Skip only our folded rows in the geometry pass;
 * keep every item in the native collection used by toArray and the save callback. */
export function retainNativePresetGeometry(root: HTMLElement) {
  let binding: { instance: any; original: (...args: any[]) => any; wrapped: (...args: any[]) => any; own: boolean } | undefined;
  function restore() {
    if (!binding) return;
    const { instance, original, wrapped, own } = binding;
    if (instance._refreshItemPositions === wrapped) {
      if (own) instance._refreshItemPositions = original;
      else delete instance._refreshItemPositions;
    }
    binding = undefined;
  }
  function sync() {
    const instance = (window as any).jQuery?.(root).data('ui-sortable');
    if (binding?.instance === instance && instance?._refreshItemPositions === binding?.wrapped) return;
    restore();
    if (typeof instance?._refreshItemPositions !== 'function') return;
    const original = instance._refreshItemPositions, own = Object.hasOwn(instance, '_refreshItemPositions');
    const wrapped = function (this: any, ...args: any[]) {
      if (!root.classList.contains('prw-native-grouped') || !Array.isArray(this.items)) return original.apply(this, args);
      const all = this.items;
      const visible = all.filter((item: any) => {
        const row = item.item?.[0] as HTMLElement | undefined;
        if (!row || !root.contains(row) || !row.classList.contains('prw-group-folded')) return true;
        // Zero-size entries cannot become native hit targets, even with an axis constraint.
        item.width = item.height = item.left = item.top = 0;
        return false;
      });
      if (visible.length === all.length) return original.apply(this, args);
      this.items = visible;
      try { return original.apply(this, args); }
      finally { this.items = all; }
    };
    instance._refreshItemPositions = wrapped;
    binding = { instance, original, wrapped, own };
  }
  return { sync, restore };
}
