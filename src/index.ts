import { createApp, markRaw } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { NativeHost } from './native';
import { installNativeMenus } from './bridge';
import type { Host, OpenRequest } from './types';

function init() {
  window.__PRW__?.destroy();
  const host = markRaw<Host>(window.__PRW_HOST__ || new NativeHost());
  const mount = document.createElement('div');
  mount.id = 'prw-mount';
  document.body.append(mount);
  const app = createApp(App, { host }).use(createPinia());
  const vm = app.mount(mount) as unknown as { open: (request: OpenRequest) => void };
  const open = (request: OpenRequest = {}) => vm.open(request);
  const buttons: HTMLElement[] = [];
  for (const [selector, kind] of [
    ['#extensions_settings2', 'preset'],
    ['#openai_api-presets', 'preset'],
    ['#regex_container', 'regex'],
  ] as const) {
    const parent = document.querySelector(selector);
    if (!parent) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button prw-open-button';
    button.append('▥ ');
    const name = document.createElement('span');
    name.className = 'prw-brand-name';
    name.textContent = 'Cの炼金工坊';
    button.append(name);
    button.title = 'Cの炼金工坊';
    button.addEventListener('click', event => {
      event.stopPropagation();
      open({ kind });
    });
    selector === '#regex_container' ? parent.prepend(button) : parent.append(button);
    buttons.push(button);
  }
  const cleanMenus = installNativeMenus(host, open);
  const destroy = () => {
    cleanMenus();
    app.unmount();
    mount.remove();
    buttons.forEach(b => b.remove());
    window.removeEventListener('pagehide', destroy);
    delete window.__PRW__;
  };
  window.__PRW__ = { open, destroy };
  window.addEventListener('pagehide', destroy);
  if (host.demo) open();
  console.info('[Cの炼金工坊] 0.1.0 已加载');
}
// jQuery ready also works when the extension is loaded after the page has initialized.
const jq = (window as any).jQuery;
function ready() {
  if (window.__PRW_HOST__) {
    init();
    return;
  }
  const c = window.SillyTavern?.getContext?.();
  if (c?.getPresetManager?.('openai')) {
    init();
    return;
  }
  const event = c?.eventTypes?.APP_READY;
  if (event) c.eventSource.once(event, init);
  else console.warn('[Cの炼金工坊] 酒馆尚未提供初始化接口');
}
if (jq) jq(ready);
else if (document.readyState !== 'loading') ready();
else window.addEventListener('load', ready, { once: true });
