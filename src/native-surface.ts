/** Top-layer popovers/dialogs still need to belong to the drawer that opened them. */
export function nativeSurface(trigger: HTMLElement) {
  return trigger.closest('#regex_container,.drawer-content') || document.body;
}
