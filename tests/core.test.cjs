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
const { QuickOperations } = require('../src/quick-operations.ts');
const { gateRegexFlag, gatePromptCollection, nativeRegexRead, installGroupRuntime } = require('../src/group-runtime.ts');
const { nativeModel } = require('../src/native-model.ts');
const { createPinia, setActivePinia } = require('pinia');
const { useWorkbench } = require('../src/workbench.ts');

function quickHarness(refs, snapshots, guard) {
  const data = clone(snapshots);
  let commits = 0;
  const host = {
    resources: kind => clone(refs.filter(r => r.kind === kind)),
    load: async ref => clone(data[ref.key]),
    commit: async items => {
      for (const { doc } of items) assert.equal(stable(data[doc.ref.key]), doc.baseline);
      commits++;
      for (const { doc, snapshot } of items) data[doc.ref.key] = clone(snapshot);
    },
    refresh: async () => {},
  };
  return { data, host, operations: new QuickOperations(host, guard), commits: () => commits };
}
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
test('清理转移工具全局正则组包含孤立记录，保留其他范围和备份', () => {
  const doc = makeDocument(ref('A', 'regex', 'global'), {
    raw: [regex('r')],
    transfer: {
      version: 2,
      groups: [
        { id: 'mixed', name: '混合', scope: 'global', memberIds: ['r', 'other'] },
        { id: 'orphan', name: '已删条目', scope: 'global', memberIds: ['missing'] },
        { id: 'char', name: '角色', scope: 'scoped', memberIds: ['r'] },
        { id: 'preset', name: '预设', scope: 'preset', memberIds: ['r'] },
      ],
    },
  });
  doc.cleanup = ['transfer'];
  const saved = serialize(doc);
  assert.deepEqual(saved.transfer.groups.map(g => g.id), ['char', 'preset']);
  assert.deepEqual(saved.raw, doc.snapshot.raw);
  assert.deepEqual(saved.own.backups[0].data, doc.snapshot.transfer);
  const orphan=makeDocument(ref('O','regex','global'),{raw:[regex('r')],transfer:{version:2,groups:[{id:'stale',scope:'global',memberIds:['missing']}]}});
  assert.equal(orphan.sources.find(s=>s.provider==='transfer').groups.length,0);
  orphan.cleanup=['transfer'];assert.deepEqual(serialize(orphan).transfer.groups,[]);
});

test('清理非全局转移工具记录仅移除当前资源成员', () => {
  const doc = makeDocument(ref('A', 'regex', 'preset'), {raw:[regex('r')],transfer:{version:2,groups:[
    {id:'mixed',name:'混合',scope:'preset',memberIds:['r','other']},
    {id:'orphan',name:'其他预设',scope:'preset',memberIds:['missing']},
    {id:'global',name:'全局',scope:'global',memberIds:['r']},
  ]}});
  doc.cleanup=['transfer'];
  const saved=serialize(doc);
  assert.deepEqual(saved.transfer.groups.map(g=>g.memberIds),[['other'],['missing'],['r']]);
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
  const storage = new Map();
  global.localStorage = { setItem(key,value) { storage.set(key,value); } };
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
    c.extensionSettings.baiBaiToolkit = {regexListGroups:{scopes:{global:{groups:[{id:'bai',name:'柏组'}],scripts:{g:{groupId:'bai',order:0}}}}}};
    c.extensionSettings.presetTransfer = {regexScriptGroupings:{version:2,groups:[{id:'transfer',name:'转移组',scope:'global',memberIds:['g']}]}};
    const [newId] = await new QuickOperations(host).transfer([{ref:globalRef,ids:['g']}],globalRef,'copy');
    assert.equal(c.extensionSettings.baiBaiToolkit.regexListGroups.scopes.global.scripts[newId].groupId,'bai');
    assert.deepEqual(c.extensionSettings.presetTransfer.regexScriptGroupings.groups[0].memberIds,['g',newId]);
    assert.equal(live.prompts[0].content,'当前未保存正文');
    assert.equal(chatEvents,0);
    c.extensionSettings.presetTransfer.regexScriptGroupings.groups.push(
      {id:'orphan',name:'已删条目',scope:'global',memberIds:['missing']},
      {id:'preset',name:'其他预设',scope:'preset',memberIds:['missing']});
    const cleanup=makeDocument(globalRef,await host.load(globalRef)),rawBefore=clone(cleanup.snapshot.raw);
    cleanup.cleanup=['transfer'];cleanup.state.suppressed=['transfer'];cleanup.state.native=true;
    cleanup.state.groups=clone(cleanup.sources.find(s=>s.provider==='baibai').groups);cleanup.state.sync=['baibai'];cleanup.dirty=true;
    const [reloaded]=await saveDocuments(host,[cleanup]);
    assert.deepEqual(c.extensionSettings.presetTransfer.regexScriptGroupings.groups.map(g=>g.id),['preset']);
    assert.deepEqual(JSON.parse(storage.get('preset-transfer-regex-script-groupings-v2')),c.extensionSettings.presetTransfer.regexScriptGroupings);
    assert.equal(reloaded.sources.some(s=>s.provider==='transfer'),false);
    assert.deepEqual(c.extensionSettings.regex,rawBefore);
    assert.equal(reloaded.state.backups.at(-1).data.groups.some(g=>g.id==='orphan'),true);
  } finally {
    delete global.window;
    delete global.localStorage;
    delete global.document;
  }
});


test('原生快捷复制放在自身下方，保留两个不同的外部分组方案', async () => {
  const r = ref('quick', 'regex', 'global');
  const snapshot = {raw:[regex('a'),regex('b')],baibai:{version:1,groups:[{id:'bai',name:'柏组'}],scripts:{a:{groupId:'bai',order:0},b:{groupId:'bai',order:1}}},transfer:{version:2,groups:[{id:'transfer',name:'另一组',scope:'global',memberIds:['a']}]}};
  const h = quickHarness([r], {[r.key]:snapshot});
  const [id] = await h.operations.transfer([{ref:r,ids:['a']}],r,'copy');
  const saved = h.data[r.key];
  assert.deepEqual(saved.raw.map(e=>e.id),['a',id,'b']);
  assert.equal(saved.raw[1].disabled,true);
  assert.deepEqual(saved.raw[1].mystery,{preserve:true});
  assert.equal(saved.baibai.scripts[id].groupId,'bai');
  assert.equal(saved.transfer.groups[0].id,'transfer');
  assert.deepEqual(saved.transfer.groups[0].memberIds,['a',id]);
  assert.deepEqual(saved.own.groups,[]);
  assert.equal(h.commits(),1);
});

test('原生预设复制与显式分组目标都就地保存，不需要工坊草稿', async () => {
  const a=ref('quick-source'), b=ref('quick-target');
  const h=quickHarness([a,b],{[a.key]:{raw:preset([prompt('one'),prompt('two')])},[b.key]:{raw:preset([prompt('target')]),baibai:{groups:[{id:'g',name:'目标组'}],prompts:{target:{groupId:'g'}}}}});
  const [copy]=await h.operations.transfer([{ref:a,ids:['one']}],a,'copy');
  assert.deepEqual(orderOfQuick(h.data[a.key].raw),['one',copy,'two']);
  const [intoGroup]=await h.operations.transfer([{ref:a,ids:['two']}],b,'copy',{provider:'baibai',id:'g'});
  assert.equal(h.data[b.key].baibai.prompts[intoGroup].groupId,'g');
  assert.deepEqual(h.data[b.key].own.groups[0].members,['target',intoGroup]);
  assert.equal(h.data[b.key].raw.extensions.regex_scripts[0].substituteRegex,2);
});
const orderOfQuick = raw => raw.prompt_order.find(o=>o.character_id===100001).order.map(e=>e.identifier);

test('原生混合范围移动按目标先保存并移除来源分组成员', async () => {
  const a=ref('g','regex','global'),b={...ref('c','regex','scoped'),avatar:'char.png'},t=ref('p','regex');
  const h=quickHarness([a,b,t],{[a.key]:{raw:[regex('a')],baibai:{groups:[{id:'g',name:'组'}],scripts:{a:{groupId:'g',order:0}}}},[b.key]:{raw:[regex('b')]},[t.key]:{raw:[]}});
  await h.operations.transfer([{ref:a,ids:['a']},{ref:b,ids:['b']}],t,'move');
  assert.equal(h.data[a.key].raw.length,0);assert.equal(h.data[b.key].raw.length,0);
  assert.deepEqual(h.data[t.key].raw.map(r=>r.id),['a','b']);
  assert.equal(h.data[a.key].baibai.scripts.a,undefined);
  assert.equal(h.commits(),1);
});

test('原生区间分组包含两端，明确采用方案后不清理另一份', async () => {
  const r=ref('range');const h=quickHarness([r],{[r.key]:{raw:preset([prompt('a'),prompt('b'),prompt('c')]),baibai:{groups:[{id:'bg',name:'柏组'}],prompts:{a:{groupId:'bg'}}},transfer:[{id:'tg',name:'保留',memberIdentifiers:['b']}]}});
  assert.equal(await h.operations.group(r,'c','a','新组','baibai'),3);
  const saved=h.data[r.key];assert.deepEqual(saved.own.groups.at(-1).members,['a','b','c']);
  assert.deepEqual(saved.transfer,[{id:'tg',name:'保留',memberIdentifiers:['b']}]);
  assert.equal(saved.baibai.prompts.b.groupId,saved.own.groups.at(-1).id);
});

test('原生快捷操作遇到未保存草稿、失效条目或切换资源时拒绝写入', async () => {
  const r=ref('guard');const snapshot={raw:preset([prompt('a')])};
  const h=quickHarness([r],{[r.key]:snapshot},()=>{throw new Error('未保存修改')});
  await assert.rejects(()=>h.operations.transfer([{ref:r,ids:['a']}],r,'copy'),/未保存修改/);
  assert.equal(h.commits(),0);assert.deepEqual(h.data[r.key],snapshot);
  await assert.rejects(()=>h.operations.erase(r,['missing']),/不存在/);
  await assert.rejects(()=>h.operations.load({...r,name:'changed'}),/切换/);
});

test('预设与三类正则暂停整组不改条目开关，恢复后保留手动修改', async () => {
  for (const r of [ref('P'),ref('G','regex','global'),ref('C','regex','scoped'),ref('R','regex','preset')]) {
    const raw=r.kind==='preset'?preset([prompt('a'),prompt('b')]):[regex('a'),{...regex('b'),disabled:true}];
    if(r.kind==='preset')raw.prompt_order[0].order[1].enabled=false;
    const h=quickHarness([r],{[r.key]:{raw,own:{version:1,groups:[{id:'g',name:'组',members:['a','b'],enabled:true}]}}});
    await h.operations.groupEnabled(r,'g',false);
    assert.deepEqual(h.data[r.key].raw,raw);
    assert.deepEqual([...core.pausedMembers(h.data[r.key].own)],['a','b']);
    const model=nativeModel(r,h.data[r.key]);
    assert.deepEqual(model.entries.map(e=>e.enabled),[true,false]);
    await h.operations.groupEnabled(r,'g',true);
    assert.deepEqual(h.data[r.key].raw,raw);
    assert.equal(core.pausedMembers(h.data[r.key].own).size,0);
    await h.operations.groupEnabled(r,'g',false);
    await h.operations.entryEnabled(r,'a',false);
    await h.operations.groupEnabled(r,'g',true);
    assert.deepEqual(nativeModel(r,h.data[r.key]).entries.map(e=>e.enabled),[false,false]);
  }
});

test('运行时正则遮罩只影响执行读取，序列化和显式开关保留原值并可卸载', () => {
  const r=regex('r'),before=clone(r);let executing=false,paused=true;
  const restore=gateRegexFlag(r,()=>paused,()=>executing);
  assert.equal(r.disabled,false);assert.deepEqual(clone(r),before);
  executing=true;assert.equal(r.disabled,true);
  paused=false;assert.equal(r.disabled,false);
  r.disabled=true;paused=true;assert.equal(r.disabled,true);
  paused=false;assert.equal(r.disabled,true);
  r.disabled=false;executing=false;assert.deepEqual(clone(r),before);
  restore();assert.deepEqual(Object.getOwnPropertyDescriptor(r,'disabled'),Object.getOwnPropertyDescriptor(before,'disabled'));
  const missing={id:'missing'};const cleanup=gateRegexFlag(missing,()=>true,()=>false);cleanup();assert.deepEqual(missing,{id:'missing'});
  assert.equal(nativeRegexRead('Error\n at runRegexScript (http://localhost/scripts/extensions/regex/engine.js:1:1)'),true);
  assert.equal(nativeRegexRead('Error\n at JSON.stringify (<anonymous>)\n at runRegexScript (http://localhost/scripts/extensions/regex/engine.js:1:1)'),false);
  assert.equal(nativeRegexRead('Error\n at runRegexScript (http://localhost/other.js:1:1)'),false);
});

test('暂停提示词从执行集合排除且不可被系统提示词重新加入', () => {
  const source=[{identifier:'a',content:'A'},{identifier:'b',content:'B'}],before=clone(source);
  const c={collection:[...source],add(...p){this.collection.push(...p)},set(p,i){this.collection[i]=p},override(p,i){this.set(p,i)}};
  gatePromptCollection(c,new Set(['a']));
  assert.deepEqual(c.collection,[source[1]]);
  c.add(source[0],{identifier:'c'});c.set(source[0],0);c.override(source[0],0);
  assert.deepEqual(c.collection.map(p=>p.identifier),['b','c']);assert.deepEqual(source,before);
  class P {constructor(){this.identifier='main';this.content='不得生效';}}
  const main=new P(),anchored={collection:[main],add(...p){this.collection.push(...p)},set(p,i){this.collection[i]=p}};
  gatePromptCollection(anchored,new Set(['main']));anchored.add(main);anchored.set(main,0);
  assert.equal(anchored.collection.every(p=>p instanceof P && p.content===''),true);
  assert.equal(main.content,'不得生效');
});

test('原生执行适配器覆盖三类正则和提示词，不修改原开关并正确卸载', async () => {
  const {EventEmitter}=require('node:events'),bus=new EventEmitter(),dom=new EventTarget(),ns=core.NS;
  const state=()=>({version:1,native:true,groups:[{id:'g',name:'组',members:['a','b'],enabled:false}]});
  const arrays=[[regex('a'),{...regex('b'),disabled:true}],[regex('a')],[regex('a')]],before=clone(arrays);
  const settings={extensions:{[ns]:{promptGroups:state(),regexGroups:state()}}};
  const c={extensionSettings:{[ns]:{regexScopes:{global:state()}}},characters:[{data:{extensions:{[ns]:{regexGroups:state()}}}}],characterId:0,
    getPresetManager:()=>({getPresetList:()=>({settings})}),eventSource:bus,eventTypes:{SETTINGS_UPDATED:'settings'}};
  const baseGet=()=>({collection:[{identifier:'a'},{identifier:'unblocked'}],add(...p){this.collection.push(...p)}}),baseDisabled=id=>id==='already-disabled';
  const baiGet=()=>({collection:[]}),baiDisabled=()=>true;
  baiGet.__baiBaiToolkitOriginalGetPromptCollection=baseGet;baiDisabled.__baiBaiToolkitOriginalIsPromptDisabledForActiveCharacter=baseDisabled;
  const pm={getPromptCollection:baiGet,isPromptDisabledForActiveCharacter:baiDisabled};
  global.window={SillyTavern:{getContext:()=>c}};global.document=dom;
  let grouping=true;global.localStorage={getItem:()=>JSON.stringify({grouping})};
  const stop=installGroupRuntime(async path=>path.includes('engine.js')?{SCRIPT_TYPES:{GLOBAL:0,PRESET:1,SCOPED:2},getScriptsByType:type=>arrays[type]}:{promptManager:pm});
  try {
    await new Promise(resolve=>setImmediate(resolve));
    for(const rows of arrays)assert.equal(typeof Object.getOwnPropertyDescriptor(rows[0],'disabled').get,'function');
    assert.deepEqual(clone(arrays),before);
    assert.deepEqual(pm.getPromptCollection().collection.map(p=>p.identifier),['unblocked']);
    assert.equal(pm.isPromptDisabledForActiveCharacter('a'),true);assert.equal(pm.isPromptDisabledForActiveCharacter('unblocked'),false);
    assert.equal(pm.isPromptDisabledForActiveCharacter('already-disabled'),true);
    grouping=false;dom.dispatchEvent(new Event('prw:grouping-preference'));await new Promise(resolve=>setImmediate(resolve));
    for(const rows of arrays)assert.equal(typeof Object.getOwnPropertyDescriptor(rows[0],'disabled').get,'undefined');
    assert.deepEqual(pm.getPromptCollection().collection,[]); // Restore the other plugin's own behavior.
    grouping=true;dom.dispatchEvent(new Event('prw:grouping-preference'));await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(pm.getPromptCollection().collection.map(p=>p.identifier),['unblocked']);
    settings.extensions[ns].promptGroups.groups[0].enabled=true;
    c.extensionSettings[ns].regexScopes.global.groups[0].enabled=true;
    bus.emit('settings');await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(pm.getPromptCollection().collection.map(p=>p.identifier),['a','unblocked']);
    assert.equal(typeof Object.getOwnPropertyDescriptor(arrays[0][0],'disabled').get,'undefined');
    assert.deepEqual(clone(arrays),before);
  } finally {stop();delete global.window;delete global.document;delete global.localStorage;}
  assert.equal(pm.getPromptCollection,baiGet);assert.equal(pm.isPromptDisabledForActiveCharacter,baiDisabled);
  assert.equal(bus.listenerCount('settings'),0);
  for(const rows of arrays)assert.equal(typeof Object.getOwnPropertyDescriptor(rows[0],'disabled').get,'undefined');
});

test('分组采用只保存当前资源，失败保留草稿，跨资源移动禁止拆开保存', async () => {
  const a=ref('A','regex','global'),b=ref('B','regex','preset'),h=quickHarness([a,b],{[a.key]:{raw:[regex('a')]},[b.key]:{raw:[regex('b')]}});
  global.localStorage={getItem:()=>null,setItem:()=>{}};
  setActivePinia(createPinia());const store=useWorkbench();store.init(h.host);
  try {
  store.documents[a.key]=makeDocument(a,await h.host.load(a));store.documents[b.key]=makeDocument(b,await h.host.load(b));
  store.documents[a.key].state.native=true;store.documents[a.key].dirty=true;
  store.documents[b.key].entries[0].name='待保存正文';store.documents[b.key].dirty=true;
  assert.equal(await store.save(a.key),true);
  assert.equal(store.documents[b.key].dirty,true);assert.equal(h.data[b.key].raw[0].scriptName,'b');
  const commit=h.host.commit;h.host.commit=async()=>{throw Error('测试保存失败')};
  assert.equal(await store.save(b.key),false);assert.equal(store.documents[b.key].dirty,true);assert.match(store.error,/保存失败/);
  h.host.commit=commit;
  store.transferAction='move';store.transfer(a.key,b.key,['a']);
  assert.throws(()=>store.checkSaveOnly(b.key),/跨预设操作/);
  assert.equal(await store.save(b.key),false);assert.equal(h.data[a.key].raw.length,1);
  assert.equal(await store.save(),true);assert.equal(h.data[a.key].raw.length,0);assert.equal(h.data[b.key].raw.length,2);
  } finally {store.$dispose();delete global.localStorage;}
});

test('相似匹配按词序和有效覆盖判断，不把短公共句与同名条目误判', () => {
  const entry=(id,text)=>entryFrom(prompt(id,text,'相同名称'),'preset');
  const common='when writing please pay attention to the following instructions';
  const novel='Write an immersive character driven novel. Describe motivations through concrete choices and consequences. Keep independent relationships believable while the narrator follows the protagonist across the city. ';
  const layout='Render an interactive panel with accessible controls. Configure the background color and contrast ratio. Resize the canvas to match the screen dimensions before updating animated visual effects. ';
  assert.equal(matchEntries(entry('same',novel.repeat(12)+common),entry('same',layout.repeat(12)+common)),null);
  assert.equal(matchEntries(entry('a','the quick brown fox'),entry('b','the quick brown cat')),null);
  assert.equal(matchEntries(entry('a','只有这一小句'),entry('b','只有这一小句'))?.type,'exact');
  const block='Along the river the old librarian carried a wooden box containing several handwritten letters from a childhood friend who had moved into the distant northern mountains many years before the storm.';
  assert.equal(matchEntries(entry('a',novel+block),entry('b',layout+block))?.type,'partial');
  assert.equal(matchEntries(entry('a',novel+block),entry('b',(novel+block).split(' ').map((word,i)=>i%12===5?'revised':word).join(' ')))?.type,'similar');
});

test('没有实际成员的分组不接管原生列表',()=>{
  const r=ref('A');
  for(const groups of [[],[{id:'empty',name:'空组',members:[],enabled:true,collapsed:false}],[{id:'stale',members:['missing']}]] )
    assert.equal(nativeModel(r,{raw:preset([prompt('a')]),own:{version:1,native:true,groups}}),undefined);
});

test('原生组暂停只写元数据，保留行对象与开关；保存失败恢复组状态',async()=>{
  const ns=core.NS,state=()=>({version:1,native:true,groups:[{id:'g',name:'组',members:['a'],enabled:true}],sync:['baibai'],suppressed:[]});
  const live=preset([prompt('a')]);live.extensions[ns]={promptGroups:state(),regexGroups:state()};
  live.extensions.baibaiToolkit={presetPromptGroups:state()};live.extensions.regex_scripts=[regex('a')];
  const c={extensionSettings:{regex:[regex('a')],[ns]:{regexScopes:{global:state()}}},characters:[{avatar:'c.png',name:'角色',data:{extensions:{regex_scripts:[regex('a')],[ns]:{regexGroups:state()}}}}],characterId:0};
  c.getPresetManager=()=>({getPresetList:()=>({preset_names:{A:0},settings:live}),getSelectedPresetName:()=>'A',getCompletionPresetByName:()=>live});
  let writes=0,fail=false;
  c.writeExtensionField=async(id,key,value)=>{writes++;c.characters[id].data.extensions[key]=clone(value)};
  const host=new NativeHost(async()=>({saveSettings:async()=>{writes++;if(fail){fail=false;throw Error('模拟断网')}}}));
  global.window={SillyTavern:{getContext:()=>c}};global.document=new EventTarget();
  const regexes=[c.extensionSettings.regex,c.characters[0].data.extensions.regex_scripts,live.extensions.regex_scripts],objects=regexes.map(r=>r[0]),before=clone(regexes),prompts=live.prompts;
  try {
    const refs=[...host.resources('regex').filter(r=>r.scope!=='preset'||r.live),host.resources('preset').find(r=>r.live)];
    for(const r of refs){assert.equal(await host.setGroupEnabled(r,'g',false),true);assert.equal((await host.load(r)).own.groups[0].enabled,false)}
    assert.equal(writes,4);assert.deepEqual(clone(regexes),before);assert.equal(live.prompts,prompts);
    regexes.forEach((r,i)=>assert.equal(r[0],objects[i]));
    assert.equal(live.extensions.baibaiToolkit.presetPromptGroups.groups[0].enabled,false);
    const r=refs.find(r=>r.scope==='global');fail=true;
    await assert.rejects(()=>host.setGroupEnabled(r,'g',true),/模拟断网/);
    assert.equal(c.extensionSettings[ns].regexScopes.global.groups[0].enabled,false);
    assert.equal(writes,6);assert.deepEqual(clone(regexes),before);
  } finally {delete global.window;delete global.document}
});

test('快速切换资源时迟到的读取不会覆盖新选择',async()=>{
  global.localStorage={getItem:()=>null,setItem:()=>{}};
  setActivePinia(createPinia());const state=useWorkbench(),a=ref('A'),b=ref('B');
  const pending={};state.init({resources:()=>[a,b],load:r=>new Promise(resolve=>pending[r.key]=resolve),commit:async()=>{},refresh:async()=>{}});
  try {
    const first=state.load('left',a.key),second=state.load('left',b.key);
    assert.equal(state.keys.left,b.key);
    pending[b.key]({raw:preset([prompt('b')])});await second;
    pending[a.key]({raw:preset([prompt('a')])});await first;
    assert.equal(state.keys.left,b.key);assert.equal(state.docs.left.entries[0].id,'b');
  } finally {state.$dispose();delete global.localStorage;}
});

test('柏宝箱折叠组只保留原生挂载，不改折叠记录，退出恢复挂载状态',()=>{
  const {retainNativeBodies}=require('../src/native-bodies.ts');
  const root={id:'completion_prompt_manager_list'},state={items:[{type:'group',groupId:'a',collapsed:true},{type:'group',groupId:'b',collapsed:false},{type:'global-library',groupId:'library',collapsed:true}],mountedGroupBodies:{b:true}};
  global.window={__baiBaiToolkitExtensionInstalled:{__baiBaiToolkitPresetVueListManager:{root,state,groupBodyUnmountTimers:new Map()}}};
  try{const keep=retainNativeBodies(root),before=clone(state.items);keep.sync();assert.deepEqual(state.mountedGroupBodies,{a:true,b:true});assert.deepEqual(state.items,before);keep.sync();keep.restore();assert.deepEqual(state.mountedGroupBodies,{b:true});assert.deepEqual(state.items,before)}finally{delete global.window}
});
