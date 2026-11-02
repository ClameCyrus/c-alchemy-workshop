import { createApp, markRaw } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { NativeHost } from './native';
import { installNativeMenus } from './bridge';
import { useWorkbench } from './workbench';
import { sameResource } from './quick-operations';
import { installGroupRuntime } from './group-runtime';
import type { Host, OpenRequest } from './types';

function init() {
  window.__PRW__?.destroy();
  const host = markRaw<Host>(window.__PRW_HOST__ || new NativeHost());
  const mount = document.createElement('div');
  mount.id = 'prw-mount';
  document.body.append(mount);
  const pinia = createPinia();
  const app = createApp(App, { host }).use(pinia);
  const vm = app.mount(mount) as unknown as { open: (request: OpenRequest) => void };
  const open = (request: OpenRequest = {}) => vm.open(request);
  const stopRuntime = host.demo ? () => {} : installGroupRuntime();
  const buttons: HTMLElement[] = [];
  const wand = document.querySelector('#extensionsMenu');
  if (wand) {
    const container = document.createElement('div');
    container.className = 'extension_container';
    container.id = 'prw-wand-container';
    const button = document.createElement('div');
    button.className = 'list-group-item flex-container flexGap5 interactable prw-wand-entry';
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.innerHTML = '<i class="fa-solid fa-flask extensionsMenuExtensionButton" aria-hidden="true"></i><span class="prw-brand-name">Cの炼金工坊</span>';
    const launch = () => { open(); document.querySelector<HTMLElement>('#extensionsMenuButton')?.click(); };
    button.addEventListener('click', launch);
    button.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); launch(); } });
    container.append(button);
    wand.append(container);
    buttons.push(container);
  }
  const presetParent = document.querySelector('#openai_api-presets');
  if (presetParent) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button prw-open-button';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-flask';
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    const name = document.createElement('span');
    name.className = 'prw-brand-name';
    name.textContent = 'Cの炼金工坊';
    button.append(name);
    button.title = 'Cの炼金工坊';
    button.addEventListener('click', event => {
      event.stopPropagation();
      open({ kind: 'preset' });
    });
    const row = document.createElement('div');
    row.id = 'prw-preset-entry';
    row.className = 'prw-entry-row';
    row.append(button);
    presetParent.append(row);
    buttons.push(row);
  }
  const cleanMenus = installNativeMenus(host, open, ref => {
    if (useWorkbench(pinia).dirty.some(doc => sameResource(doc.ref, ref)))
      throw new Error('工坊里有这份资源的未保存修改，请先保存或放弃后再试');
  });
  const destroy = () => {
    stopRuntime();
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
