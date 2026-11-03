import { settingsOf, stable } from './core';
import type { Entry } from './types';
const labels: Record<string, string> = { enabled: '条目开关', role: '角色', position: '插入位置', depth: '深度', order: '顺序', triggers: '触发条件', overrides: '禁止覆盖', placement: '作用范围', trim: '裁剪文本', substitute: '替换宏', min: '最小深度', max: '最大深度', markdown: '仅显示', prompt: '仅提示词', edit: '编辑时运行' };
function display(key: string, value: unknown): string {
  if (value === undefined || value === null) return '未设置';
  if (typeof value === 'boolean') return key === 'enabled' ? value ? '启用' : '停用' : value ? '是' : '否';
  if (key === 'role') return ({ system: '系统', user: '用户', assistant: 'AI', regex: '正则' } as Record<string, string>)[String(value)] || String(value);
  if (key === 'position') return ({ 0: '相对位置', 1: '聊天内' } as Record<string, string>)[String(value)] || String(value);
  if (key === 'substitute') return ({ 0: '不替换', 1: '替换', 2: '转义替换' } as Record<string, string>)[String(value)] || String(value);
  if (Array.isArray(value)) {
    if (!value.length) return '无';
    const scopes: Record<string, string> = { 1: '用户', 2: 'AI', 3: '命令', 5: '世界书', 6: '推理' };
    return value.map(v => key === 'placement' ? scopes[String(v)] || String(v) : String(v)).join('、');
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
export function settingDifferences(left?: Entry, right?: Entry) {
  if (!left || !right) return [];
  const a = settingsOf(left), b = settingsOf(right);
  return Object.keys(labels).filter(key => stable(a[key]) !== stable(b[key])).map(key => ({ key, label: labels[key], left: display(key, a[key]), right: display(key, b[key]) }));
}
