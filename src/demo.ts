import { clone, makeDocument, stable } from './core';
import type { Host, Kind, Raw, Resource, Snapshot, WorkDocument } from './types';
const block = '保持角色叙事连贯，避免替玩家决定行动。根据当前场景补充环境细节，并让对话自然推动剧情发展。';
const prompt = (id: string, name: string, content: string): Raw => ({
  identifier: id,
  name,
  content,
  role: 'system',
  system_prompt: false,
  marker: false,
  injection_position: 0,
  injection_depth: 4,
  injection_order: 100,
  unknownField: { preserve: true },
});
const preset = (prompts: Raw[], unused: Raw[] = []): Raw => ({
  temperature: 0.9,
  prompts: [...prompts, ...unused],
  prompt_order: [{ character_id: 100001, order: prompts.map(p => ({ identifier: p.identifier, enabled: true })) }],
  extensions: {
    regex_scripts: [
      {
        id: 'embedded',
        scriptName: '宏保持',
        substituteRegex: 2,
        findRegex: '/{{user}}/g',
        replaceString: '{{user}}',
        disabled: true,
        placement: [2],
        extra: 'keep',
      },
    ],
    keepMe: { hello: true },
  },
});
const regex = (id: string, scriptName: string, findRegex: string, replaceString: string): Raw => ({
  id,
  scriptName,
  findRegex,
  replaceString,
  disabled: false,
  placement: [2],
  trimStrings: [' '],
  substituteRegex: 2,
  minDepth: null,
  maxDepth: 6,
  markdownOnly: true,
  promptOnly: false,
  runOnEdit: true,
  unknownField: { keep: '完整保留' },
});
const refs: Resource[] = [
  { key: 'preset:preset:春日来信', label: '春日来信', kind: 'preset', scope: 'preset', name: '春日来信' },
  { key: 'preset:preset:旧城手记', label: '旧城手记', kind: 'preset', scope: 'preset', name: '旧城手记' },
  { key: 'regex:global', label: '全局正则', kind: 'regex', scope: 'global' },
  {
    key: 'regex:scoped:demo.png',
    label: '角色 · 芙林',
    kind: 'regex',
    scope: 'scoped',
    characterId: 0,
    avatar: 'demo.png',
  },
  { key: 'regex:preset:春日来信', label: '春日来信', kind: 'regex', scope: 'preset', name: '春日来信' },
];
const data: Record<string, Snapshot> = {
  [refs[0].key]: {
    raw: preset(
      [
        prompt('a0', '叙事基调', block),
        prompt('a1', '世界细节', '城市沿着运河延伸，旧港区保留着石板路与黄铜路灯。雨后可以听到远处的钟声。'),
        prompt('a2', '角色边界', '只描述可感知的细节，不替用户做出未表达的决定。让角色根据经历形成自己的判断。'),
        prompt('a3', '对话节奏', '让交谈有来有回。允许短暂沉默与自然打断，避免每段都给出总结。'),
        prompt('a4', '春日场景', '庭院里的藤蔓开始发芽，阳光落在白色窗台上。这里是春日来信独有的场景。'),
        prompt('a5', '细节补充', '用少量具体感官细节呈现场景。把变化放在行动中，给人物留出回应的空间。'),
      ],
      [prompt('unused', '未启用的备用条目', '这条保留在预设内，尚未加入列表。')],
    ),
    baibai: {
      version: 1,
      groups: [
        { id: 'b-narrative', name: '叙事', order: 0, collapsed: false },
        { id: 'b-scene', name: '场景', order: 1, collapsed: true },
      ],
      prompts: {
        a0: { groupId: 'b-narrative' },
        a2: { groupId: 'b-narrative' },
        a1: { groupId: 'b-scene' },
        a4: { groupId: 'b-scene' },
      },
    },
    transfer: [
      { id: 't-core', name: '基础约定', memberIdentifiers: ['a0', 'a2', 'a3'], mode: 'inclusive' },
      { id: 't-world', name: '世界与场景', memberIdentifiers: ['a1', 'a4', 'a5'], mode: 'inclusive' },
    ],
  },
  [refs[1].key]: {
    raw: preset([
      prompt('b0', '故事风格', block),
      prompt('b1', '叙事与人物', `${block}\n人物的日常选择应与经历有关，在重要节点允许他们改变看法。`),
      prompt(
        'b2',
        '叙事基调修订',
        '保持人物叙事连贯，避免替玩家决定行动。根据当前场景补充天气和环境细节，让交谈自然推动剧情发展。',
      ),
      prompt('b3', '旧城规则', '城内不允许使用远距离传送。钟塔的开放时间以守卫公告为准。'),
      prompt('b4', '对话节奏', '交谈应有来有回，适当保留停顿与打断，不需要每一段都总结。'),
      prompt('b5', '气候', '旧城的冬季漫长，河面在深夜结冰，清晨的雾常常笼罩石桥。'),
    ]),
  },
  [refs[2].key]: {
    raw: [
      regex('r1', '折叠思考', '/<think>([\\s\\S]*?)<\\/think>/g', '<details><summary>思考</summary>$1</details>'),
      regex('r2', '清理多余换行', '/\\n{3,}/g', '\n\n'),
      regex('r3', '称呼替换', '/{{user}}/g', '{{user}}'),
      regex('r4', '移除提示标签', '/<hint>.*?<\\/hint>/g', ''),
    ],
    baibai: {
      version: 1,
      groups: [{ id: 'rg', name: '显示整理', order: 0, collapsed: false }],
      scripts: { r1: { groupId: 'rg', order: 0 }, r2: { groupId: 'rg', order: 1 } },
    },
    transfer: {
      version: 2,
      groups: [{ id: 'rt', name: '基础修饰', scope: 'global', memberIds: ['r2', 'r3'], collapsed: false }],
    },
  },
  [refs[3].key]: { raw: [regex('cr1', '角色对白', '/「([^」]+)」/g', '<span class="dialogue">$1</span>')] },
  [refs[4].key]: { raw: [regex('pr1', '备用格式', '/^(.+)$/gm', '<p>$1</p>')] },
};
class DemoHost implements Host {
  demo = true;
  resources(kind: Kind) {
    return clone(refs.filter(r => r.kind === kind));
  }
  async load(ref: Resource) {
    if (!data[ref.key]) throw new Error('演示资源不存在');
    return clone(data[ref.key]);
  }
  async commit(items: { doc: WorkDocument; snapshot: Snapshot }[]) {
    for (const { doc } of items) if (stable(data[doc.ref.key]) !== doc.baseline) throw new Error('演示资源已变更');
    for (const { doc, snapshot } of items) data[doc.ref.key] = clone(snapshot);
  }
  async refresh() {}
}
window.__PRW_HOST__ = new DemoHost();
// Deliberately no TavernHelper global: the preview proves independent startup.
Object.assign(window, {
  __PRW_DEMO_DATA__: data,
  __PRW_DEMO_REFS__: refs,
  __PRW_DEMO_DOCUMENT__: (key: string) =>
    makeDocument(
      refs.find(r => r.key === key)!,
      data[key],
    ),
});
