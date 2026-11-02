declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<any, any, any>;
  export default component;
}
interface Window {
  SillyTavern?: any;
  __PRW_HOST__?: import('./types').Host;
  __PRW__?: { open: (request?: import('./types').OpenRequest) => void; destroy: () => void };
}
