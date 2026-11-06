export type Raw = Record<string, any>;
export type Provider = 'baibai' | 'transfer';
export type Kind = 'preset' | 'regex';
export type Scope = 'global' | 'scoped' | 'preset';
export type Side = 'left' | 'right';
export interface Resource {
  key: string;
  label: string;
  kind: Kind;
  scope: Scope;
  name?: string;
  live?: boolean;
  characterId?: number;
  avatar?: string;
}
export interface Entry {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  role: string;
  raw: Raw;
  unused?: boolean;
}
export interface Group {
  id: string;
  name: string;
  members: string[];
  collapsed: boolean;
  enabled: boolean;
  extra?: Raw;
}
export interface GroupState {
  version: 1;
  native?: boolean;
  groups: Group[];
  sync: Provider[];
  suppressed: Provider[];
  backups?: Raw[];
}
export interface Snapshot {
  raw: any;
  file?: Snapshot;
  own?: any;
  baibai?: any;
  transfer?: any;
  legacyOwn?: any;
  namespace?: { current?: any; legacy?: any };
}
export interface GroupSource {
  provider: 'own' | 'legacy' | Provider;
  label: string;
  groups: Group[];
  raw: any;
}
export interface WorkDocument {
  ref: Resource;
  baseline: string;
  snapshot: Snapshot;
  entries: Entry[];
  unused: Entry[];
  state: GroupState;
  sources: GroupSource[];
  cleanup: Provider[];
  providerGroups?: Partial<Record<Provider, Group[]>>;
  dirty: boolean;
  legacyResolved?: boolean;
}
export interface Host {
  demo?: boolean;
  resources: (kind: Kind) => Resource[];
  load: (ref: Resource) => Promise<Snapshot>;
  commit: (items: { doc: WorkDocument; snapshot: Snapshot }[]) => Promise<void>;
  refresh: (refs: Resource[]) => Promise<void>;
  edit?: (ref: Resource, id: string) => Promise<void | boolean>;
  setGroupEnabled?: (ref: Resource, id: string, enabled: boolean) => Promise<boolean>;
  loadLibrary?: () => Promise<import('./library').MaterialLibrary>;
  saveLibrary?: (value: import('./library').MaterialLibrary, baseline: string) => Promise<void>;
  worldbooks?: () => Promise<string[]>;
  loadWorldbook?: (name: string) => Promise<Raw>;
}
export interface OpenRequest {
  kind?: Kind;
  refKey?: string;
  entryId?: string;
  ids?: string[];
  sources?: { refKey: string; ids: string[] }[];
  action?: 'edit' | 'copy' | 'move' | 'group' | 'delete' | 'detach' | 'collect';
}
export interface Match {
  type: 'exact' | 'partial' | 'similar';
  score: number;
  coverage: number;
  settingsDifferent: boolean;
}
