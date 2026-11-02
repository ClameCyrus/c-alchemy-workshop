const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText,
    filename,
  );
const core = require('../src/core.ts');
const { NativeHost, saveDocuments } = require('../src/native.ts');
const {
  clone,
  makeDocument,
  serialize,
  transferEntries,
  matchEntries,
  entryFrom,
  assignGroup,
  rangeMembers,
  removeEntries,
  stable,
} = core;
function ref(name, kind = 'preset', scope = 'preset') {
  return { key: `${kind}:${scope}:${name}`, label: name, name, kind, scope };
}
function prompt(
  identifier,
  content = '一段足够长的正文，用于验证部分相同和相似匹配。人物的行动应保持连贯，并且留出回应空间。',
  name = identifier,
) {
  return { identifier, name, content, role: 'system', marker: false, system_prompt: false, extra: { untouched: true } };
}
function preset(rows, unused = []) {
  return {
    temperature: 0.75,
    prompts: [...rows, ...unused],
    prompt_order: [
      { character_id: 100001, order: rows.map(p => ({ identifier: p.identifier, enabled: true, extra: 'order' })) },
    ],
    extensions: {
      regex_scripts: [{ id: 'raw-regex', scriptName: '保留', substituteRegex: 2, placement: [2], mystery: [1, 2] }],
      other: { keep: true },
    },
  };
}
function regex(id, name = id) {
  return {
    id,
    scriptName: name,
    disabled: false,
    findRegex: '/{{user}}/g',
    replaceString: '{{char}}',
    placement: [1, 2],
    trimStrings: [' '],
    substituteRegex: 2,
    minDepth: null,
    maxDepth: 3,
    markdownOnly: true,
    runOnEdit: true,
    mystery: { preserve: true },
  };
}
test('编辑预设保留嵌入正则、未知字段、未加入列表和排序扩展', () => {
  const raw = preset([prompt('a'), prompt('b')], [prompt('u')]);
  const doc = makeDocument(ref('A'), { raw });
  doc.entries[0].content = '修改';
  const saved = serialize(doc);
  assert.deepEqual(saved.raw.extensions, raw.extensions);
  assert.deepEqual(saved.raw.prompts[0].extra, { untouched: true });
  assert.equal(saved.raw.prompts[2].identifier, 'u');
  assert.equal(saved.raw.prompt_order[0].order[0].extra, 'order');
  assert.equal(raw.prompts[0].content, prompt('a').content);
});
test('正则批量复制新ID、默认关闭、重名后缀、完整深拷贝', () => {
  const source = makeDocument(ref('S', 'regex', 'global'), { raw: [regex('r', '称呼'), regex('r2', '格式')] });
  const target = makeDocument(ref('T', 'regex'), { raw: [regex('x', '称呼（副本）')] });
  const ids = transferEntries(source, target, ['r2', 'r'], 'copy');
  assert.equal(ids.length, 2);
  assert.deepEqual(
    target.entries.map(e => e.name),
    ['称呼（副本）', '称呼（副本） 2', '格式（副本）'],
  );
  assert.ok(target.entries.slice(1).every(e => !e.enabled));
  assert.equal(new Set(target.entries.map(e => e.id)).size, 3);
  const saved = serialize(target).raw;
  assert.equal(saved[1].substituteRegex, 2);
  assert.deepEqual(saved[1].mystery, { preserve: true });
  assert.equal(saved[1].disabled, true);
  assert.equal(source.entries[0].enabled, true);
  target.entries[1].raw.mystery.preserve = false;
  assert.equal(source.entries[0].raw.mystery.preserve, true);
});
test('多选插入按来源自然顺序并支持同列表移动', () => {
  const doc = makeDocument(ref('A'), { raw: preset(['a', 'b', 'c', 'd'].map(x => prompt(x))) });
  transferEntries(doc, doc, ['d', 'b'], 'move', 'a');
  assert.deepEqual(
    doc.entries.map(e => e.id),
    ['b', 'd', 'a', 'c'],
  );
  transferEntries(doc, doc, ['b', 'd'], 'move', 'c', true);
  assert.deepEqual(
    doc.entries.map(e => e.id),
    ['a', 'c', 'b', 'd'],
  );
});
test('跨列表移动遇到ID冲突创建新ID，目标分组正确', () => {
  const a = makeDocument(ref('A'), { raw: preset([prompt('same')]) });
  const b = makeDocument(ref('B'), {
    raw: preset([prompt('same')]),
    own: { version: 1, groups: [{ id: 'g', name: '目标', members: [] }] },
  });
  const ids = transferEntries(a, b, ['same'], 'move', undefined, false, 'g');
  assert.notEqual(ids[0], 'same');
  assert.equal(a.entries.length, 0);
  assert.deepEqual(b.state.groups[0].members, ids);
});
test('转移预校验失败不移除来源，系统条目不可复制删除', () => {
  const a = makeDocument(ref('A'), { raw: preset([prompt('a')]) });
  const b = makeDocument(ref('B'), { raw: preset([prompt('b')]) });
  const before = stable(a);
  assert.throws(() => transferEntries(a, b, ['a'], 'move', 'not-found'));
  assert.equal(stable(a), before);
  a.entries[0].raw.marker = true;
  assert.throws(() => removeEntries(a, ['a']));
  assert.throws(() => transferEntries(a, b, ['a'], 'copy'));
});
test('一对多包含完全相同、长段落包含和相似修订，短公共标签不误报', () => {
  const a = entryFrom(prompt('a'), 'preset');
  const exact = entryFrom(prompt('different-id', a.content, '改名'), 'preset');
  const partial = entryFrom(prompt('c', a.content + '\n这是一段额外的叙事规则。'), 'preset');
  const similar = entryFrom(prompt('d', a.content.replace('人物', '角色').replace('连贯', '连续')), 'preset');
  assert.equal(matchEntries(a, exact).type, 'exact');
  assert.equal(matchEntries(a, partial).type, 'partial');
  assert.equal(matchEntries(a, similar).type, 'similar');
  assert.equal(
    matchEntries(
      entryFrom(prompt('x', '<status>'), 'preset'),
      entryFrom(prompt('y', '<status>其他无关内容'), 'preset'),
    ),
    null,
  );
});
test('正文相同但设置不同单独标记', () => {
  const a = entryFrom(prompt('a'), 'preset'),
    b = clone(a);
  b.enabled = false;
  const m = matchEntries(a, b);
  assert.equal(m.type, 'exact');
  assert.equal(m.settingsDifferent, true);
});
test('分组取舍清理只删除元数据，保留条目和备份并抑制重新生成', () => {
  const doc = makeDocument(ref('A'), {
    raw: preset([prompt('a'), prompt('b')]),
    baibai: { groups: [{ id: 'g', name: '旧分组' }], prompts: { a: { groupId: 'g' } } },
    transfer: [{ id: 't', name: '转移', memberIdentifiers: ['b'] }],
  });
  doc.state.groups = clone(doc.sources.find(s => s.provider === 'transfer').groups);
  doc.cleanup = ['baibai'];
  doc.state.suppressed = ['baibai'];
  doc.state.sync = ['baibai', 'transfer'];
  const saved = serialize(doc);
  assert.equal(saved.baibai, undefined);
  assert.equal(saved.raw.prompts.length, 2);
  assert.equal(saved.own.backups[0].provider, 'baibai');
  assert.deepEqual(saved.own.groups[0].members, ['b']);
  doc.cleanup = [];
  doc.snapshot = saved;
  assert.equal(serialize(doc).baibai, undefined);
});
test('清理转移工具正则组保留其他资源成员与其他范围', () => {
  const doc = makeDocument(ref('A', 'regex', 'global'), {
    raw: [regex('r')],
    transfer: {
      version: 2,
      groups: [
        { id: 'mixed', name: '混合', scope: 'global', memberIds: ['r', 'other'] },
        { id: 'char', name: '角色', scope: 'scoped', memberIds: ['r'] },
      ],
    },
  });
  doc.cleanup = ['transfer'];
  const saved = serialize(doc);
  assert.deepEqual(saved.transfer.groups[0].memberIds, ['other']);
  assert.deepEqual(saved.transfer.groups[1].memberIds, ['r']);
});
test('旧起止分组兼容、反向范围包含两端、移除保留未加入条目', () => {
  const doc = makeDocument(ref('A'), {
    raw: preset(['a', 'b', 'c'].map(x => prompt(x))),
    transfer: [{ id: 'g', name: '范围', startIdentifier: 'a', endIdentifier: 'c', mode: 'exclusive' }],
  });
  assert.deepEqual(doc.sources[0].groups[0].members, ['b']);
  assert.deepEqual(rangeMembers(doc, 'c', 'a'), ['a', 'b', 'c']);
  removeEntries(doc, ['b'], true);
  assert.equal(doc.unused[0].id, 'b');
  assert.equal(serialize(doc).raw.prompts.length, 3);
});
test('同范围复制继承分组，跨范围默认未分组', () => {
  const a = makeDocument(ref('A', 'regex', 'global'), {
    raw: [regex('r')],
    own: { version: 1, groups: [{ id: 'g', name: '组', members: ['r'] }] },
  });
  const b = makeDocument(ref('B', 'regex'), { raw: [] });
  const same = transferEntries(a, a, ['r'], 'copy');
  assert.ok(a.state.groups[0].members.includes(same[0]));
  transferEntries(a, b, ['r'], 'copy');
  assert.equal(b.state.groups.length, 0);
});
test('保存失败保留草稿；成功后重新读出服务器状态并仅刷新相关资源', async () => {
  const doc = makeDocument(ref('A'), { raw: preset([prompt('a')]) });
  doc.entries[0].name = '修改';
  doc.dirty = true;
  const host = {
    load: async () => {
      throw Error('not reached');
    },
    commit: async () => {
      throw Error('保存失败');
    },
    refresh: async () => {},
  };
  await assert.rejects(() => saveDocuments(host, [doc]), /保存失败/);
  assert.equal(doc.dirty, true);
  let stored, refreshed;
  host.commit = async items => {
    stored = clone(items[0].snapshot);
  };
  host.load = async () => stored;
  host.refresh = async refs => {
    refreshed = refs;
  };
  const result = await saveDocuments(host, [doc]);
  assert.equal(result[0].dirty, false);
  assert.equal(result[0].entries[0].name, '修改');
  assert.equal(refreshed.length, 1);
});
test('重复ID拒绝载入，分组成员不会静默指向另一条目', () => {
  assert.throws(() => makeDocument(ref('X', 'regex'), { raw: [regex('a'), regex('a')] }), /重复/);
});
test('外部修改冲突在任何写入前阻止保存', async () => {
  const resource = ref('global', 'regex', 'global'),
    snap = { raw: [regex('r')] };
  const doc = makeDocument(resource, snap),
    host = new NativeHost();
  let writes = 0;
  host.load = async () => ({ raw: [regex('new')] });
  host.persist = async () => {
    writes++;
  };
  await assert.rejects(() => host.commit([{ doc, snapshot: serialize(doc) }]), /别处修改/);
  assert.equal(writes, 0);
});
test('跨资源保存部分失败恢复目标和来源，恢复失败明确报告', async () => {
  const refs = [ref('target', 'regex', 'global'), ref('source', 'regex', 'scoped')];
  const map = Object.fromEntries(refs.map(r => [r.key, { raw: [regex(r.name)] }]));
  const before = clone(map),
    docs = refs.map(r => makeDocument(r, map[r.key]));
  const host = new NativeHost();
  host.load = async r => clone(map[r.key]);
  let fail = true;
  host.persist = async (r, snap) => {
    map[r.key] = clone(snap);
    if (r.key === refs[1].key && fail) {
      fail = false;
      throw Error('写入中断');
    }
  };
  docs[0].entries.push(entryFrom(regex('new'), 'regex'));
  docs[1].entries = [];
  await assert.rejects(() => host.commit(docs.map(doc => ({ doc, snapshot: serialize(doc) }))), /写入中断/);
  assert.deepEqual(map, before);
  let writes = 0;
  host.persist = async () => {
    writes++;
    throw Error('连接中断');
  };
  await assert.rejects(() => host.commit(docs.map(doc => ({ doc, snapshot: serialize(doc) }))), /恢复失败/);
  assert.ok(writes >= 2);
});
test('原生适配器独立保存三类正则，保留当前未保存正文与其他扩展', async () => {
  const saved = preset([prompt('a')]),
    live = clone(saved);
  live.prompts[0].content = '当前未保存正文';
  const c = {
    extensionSettings: { regex: [regex('g')], untouched: { keep: true } },
    characters: [
      { avatar: 'c.png', name: '角色', data: { extensions: { regex_scripts: [regex('c')], other: 'keep' } } },
    ],
    characterId: 0,
  };
  let saveCalls = 0,
    chatEvents = 0;
  const manager = {
    getPresetList: () => ({ presets: [saved], preset_names: { A: 0 }, settings: live }),
    getSelectedPresetName: () => 'A',
    getCompletionPresetByName: () => saved,
    savePreset: async (_name, raw) => {
      Object.assign(saved, clone(raw));
    },
  };
  c.getPresetManager = () => manager;
  c.writeExtensionField = async (id, key, value) => {
    c.characters[id].data.extensions[key] = clone(value);
  };
  c.eventTypes = { CHAT_CHANGED: 'chat' };
  c.eventSource = {
    events: { chat: [] },
    emit: () => {
      chatEvents++;
    },
  };
  global.window = { SillyTavern: { getContext: () => c } };
  global.localStorage = { setItem() {} };
  global.document = { querySelector: () => null };
  const host = new NativeHost(async path =>
    path === '/script.js'
      ? {
          saveSettings: async () => {
            saveCalls++;
          },
        }
      : { promptManager: { render: async () => {} } },
  );
  try {
    const resources = host.resources('regex');
    assert.equal(resources.length, 4);
    assert.equal(typeof global.window.TavernHelper, 'undefined');
    const globalRef = resources.find(r => r.scope === 'global'),
      charRef = resources.find(r => r.scope === 'scoped'),
      presetRef = resources.find(r => r.name === 'A' && !r.live);
    const target = makeDocument(presetRef, await host.load(presetRef));
    const source = makeDocument(globalRef, await host.load(globalRef));
    transferEntries(source, target, ['g'], 'copy');
    await saveDocuments(host, [target]);
    assert.equal(live.prompts[0].content, '当前未保存正文');
    assert.equal(saved.prompts[0].content, prompt('a').content);
    assert.equal(saved.extensions.regex_scripts[1].substituteRegex, 2);
    assert.equal(saved.extensions.regex_scripts[1].disabled, true);
    assert.deepEqual(saved.extensions.other, { keep: true });
    assert.equal(saved.extensions.baibaiToolkit, undefined);
    const characterDoc = makeDocument(charRef, await host.load(charRef));
    transferEntries(source, characterDoc, ['g'], 'copy');
    await saveDocuments(host, [characterDoc]);
    assert.equal(c.characters[0].data.extensions.other, 'keep');
    assert.equal(c.characters[0].data.extensions.regex_scripts.length, 2);
    source.entries[0].name = '全局修改';
    source.dirty = true;
    await saveDocuments(host, [source]);
    assert.equal(c.extensionSettings.regex[0].scriptName, '全局修改');
    assert.deepEqual(c.extensionSettings.untouched, { keep: true });
    assert.equal(c.extensionSettings.baiBaiToolkit, undefined);
    assert.equal(c.extensionSettings.presetTransfer, undefined);
    assert.equal(chatEvents, 0);
    assert.ok(saveCalls >= 3);
  } finally {
    delete global.window;
    delete global.localStorage;
    delete global.document;
  }
});
