declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<any, any, any>;
  export default component;
}
interface Window {
  SillyTavern?: any;
  __PRW_HOST__?: import('./types').Host;
  __PRW__?: {
    open: (request?: import('./types').OpenRequest) => void;
    /** True when opened, false when unavailable. A rejected call must not fall back to a second open. */
    openRecentCharacterChat: (target: import('./native-recent-chat').RecentCharacterChat) => Promise<boolean>;
    destroy: () => void;
  };
}
