import type { Entry, WorkDocument } from './types';

export type VariableScope = 'local' | 'global';
export interface VariableMacro {
  start: number; end: number; nameStart: number; nameEnd: number;
  name: string; scope: VariableScope; action: string; value?: string; dynamic: boolean;
}
export interface VariableScan { macros: VariableMacro[]; issues: string[] }
const escaped = (text: string, at: number) => {
  let count = 0; while (at > 0 && text[--at] === '\\') count++;
  return count % 2 === 1;
};
export function scanVariables(text: string): VariableScan {
  const macros: VariableMacro[] = [], issues: string[] = [], stack: { start: number; child: number[] }[] = [];
  const nodes: { start: number; end: number; child: number[] }[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (escaped(text, i)) continue;
    if (text.startsWith('{{', i)) {
      stack.at(-1)?.child.push(i); stack.push({ start: i, child: [] }); i++;
    } else if (text.startsWith('}}', i) && stack.length) {
      nodes.push({ ...stack.pop()!, end: i + 2 }); i++;
    }
  }
  if (stack.length) issues.push('存在未闭合宏，请先检查正文');
  const byStart = new Map(nodes.map(n => [n.start, n]));
  const comments = nodes.filter(n => /^\s*\/\//.test(text.slice(n.start + 2, n.end - 2)));
  for (const node of nodes) {
    if (comments.some(c => node.start >= c.start && node.end <= c.end)) continue;
    const body = text.slice(node.start + 2, node.end - 2);
    const head = /^\s*((?:set|get|add|inc|dec|has|delete)(?:global)?var)\s*(?:::|\s)/i.exec(body);
    if (!head) {
      if (/^\s*[.$]/.test(body) || /^\s*[#~^!]*\s*(?:set|get|add|inc|dec|has|delete)(?:global)?var\b/i.test(body))
        issues.push('包含暂不自动改写的变量语法，请保留原样或手动编辑');
      continue;
    }
    const action = head[1].toLowerCase();
    const nameStart = node.start + 2 + head[0].length;
    let end = node.end - 2;
    for (let i = nameStart; i < node.end - 2; i++) {
      const child = byStart.get(i);
      if (child) { i = child.end - 1; continue; }
      if (text.startsWith('::', i)) { end = i; break; }
    }
    const rawName = text.slice(nameStart, end), name = rawName.trim();
    const begin = nameStart + rawName.indexOf(name);
    const dynamic = name.includes('{{') || !name;
    if (dynamic) issues.push('包含动态变量名，请手动确认对应关系');
    macros.push({ start: node.start, end: node.end, nameStart: begin, nameEnd: begin + name.length,
      name, scope: action.includes('global') ? 'global' : 'local', action,
      value: end < node.end - 2 ? text.slice(end + 2, node.end - 2) : undefined, dynamic });
  }
  return { macros: macros.sort((a, b) => a.start - b.start), issues: [...new Set(issues)] };
}
export const variableKey = (scope: VariableScope, name: string) => `${scope}:${name}`;
export function validVariableName(name: string) {
  return !!name.trim() && name === name.trim() && !/[:{}\r\n\\]/.test(name);
}
export function renameVariables(text: string, names: Record<string, string>): string {
  const scan = scanVariables(text);
  if (scan.issues.length && Object.entries(names).some(([key, value]) => key.slice(key.indexOf(':') + 1) !== value))
    throw new Error('此正文有复杂或未闭合宏，无法自动改名，请先保留原样或手动编辑');
  let result = text;
  for (const m of [...scan.macros].sort((a, b) => b.nameStart - a.nameStart)) {
    const next = names[variableKey(m.scope, m.name)];
    if (next === undefined || next === m.name) continue;
    if (m.dynamic || !validVariableName(next)) throw new Error('变量名不能包含冒号、括号、反斜线或换行');
    result = result.slice(0, m.nameStart) + next + result.slice(m.nameEnd);
  }
  return result;
}
export function variableMacro(scope: VariableScope, name: string, value?: string) {
  if (!validVariableName(name)) throw new Error('变量名不能包含冒号、括号、反斜线或换行');
  return value === undefined ? `{{get${scope === 'global' ? 'global' : ''}var::${name}}}`
    : `{{set${scope === 'global' ? 'global' : ''}var::${name}::${value}}}`;
}

export interface VariableLocation {
  entry: Entry;
  macro: VariableMacro;
  paused: boolean;
}
export interface IndexedVariable {
  key: string;
  scope: VariableScope;
  name: string;
  reads: VariableLocation[];
  writes: VariableLocation[];
  emptySets: VariableLocation[];
  other: VariableLocation[];
}
const entryScans = new WeakMap<Entry, { content: string; scan: VariableScan }>();
export function indexVariables(doc: WorkDocument, draft?: Entry, grouping = true) {
  const variables = new Map<string, IndexedVariable>();
  const issues: { entry: Entry; message: string }[] = [];
  const paused = new Set(grouping ? doc.state.groups.filter(group => !group.enabled).flatMap(group => group.members) : []);
  const entries = [...doc.entries, ...doc.unused];
  if (draft && !entries.some(entry => entry.id === draft.id)) entries.push(draft);
  for (const original of entries) {
    const entry = original.id === draft?.id ? draft : original;
    let cached = entryScans.get(entry);
    if (cached?.content !== entry.content) {
      cached = { content: entry.content, scan: scanVariables(entry.content) };
      entryScans.set(entry, cached);
    }
    const { scan } = cached;
    issues.push(...scan.issues.map(message => ({ entry, message })));
    for (const macro of scan.macros) {
      if (macro.dynamic) continue;
      const key = variableKey(macro.scope, macro.name);
      const variable = variables.get(key) ?? { key, scope: macro.scope, name: macro.name, reads: [], writes: [], emptySets: [], other: [] };
      const location = { entry, macro, paused: paused.has(entry.id) };
      if (macro.action.startsWith('get')) variable.reads.push(location);
      else if (macro.action.startsWith('set')) {
        variable.writes.push(location);
        if (macro.value?.trim() === '') variable.emptySets.push(location);
      }
      else variable.other.push(location);
      variables.set(key, variable);
    }
  }
  return { variables: [...variables.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')), issues };
}

export function spliceVariableText(content: string, start: number, end: number, text: string) {
  return content.slice(0, start) + text + content.slice(end);
}
export function textareaOffset(content: string, offset: number) {
  return content.slice(0, offset).replace(/\r\n/g, '\n').length;
}
export function textSelection(content: string, area?: HTMLTextAreaElement) {
  function originalOffset(offset: number) {
    for (const match of content.matchAll(/\r\n/g)) {
      if (match.index >= offset) break;
      offset++;
    }
    return offset;
  }
  return {
    start: area ? originalOffset(area.selectionStart) : content.length,
    end: area ? originalOffset(area.selectionEnd) : content.length,
  };
}
