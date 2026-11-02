const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const url = pathToFileURL(path.join(root, 'preview.html')).href;
const out = path.join(root, 'verification');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const channel = process.env.PRW_BROWSER_CHANNEL ?? (process.env.CI ? '' : 'chrome');
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const errors = [],
    results = [];
  async function fresh(width = 1440, height = 1000) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', error => errors.push(error.message));
    if (process.env.PRW_OFFLINE_TEST === '1') {
      await page.route('https://fontsapi.zeoseven.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    }
    await page.goto(url);
    await page.locator('#prw-panel .entry').first().waitFor();
    return page;
  }
  async function check(name, fn) {
    await fn();
    results.push(name);
    console.log('PASS ' + name);
  }
  try {
    const page = await fresh();
    await check('独立启动，无酒馆助手全局', async () => {
      assert.equal(await page.evaluate(() => typeof window.TavernHelper), 'undefined');
    });
    const left = page.locator('.prw-column').nth(0),
      right = page.locator('.prw-column').nth(1);
    await right.locator('.resource-bar select').selectOption('preset:preset:旧城手记');
    await check('一对多匹配，点击候选保留基准', async () => {
      await left.locator('[data-entry-id="a0"] strong').click();
      await expect(right.locator('.entry')).toHaveCount(3);
      assert.equal(await right.locator('.entry.exact').count(), 1);
      assert.equal(await right.locator('.entry.partial').count(), 1);
      assert.equal(await right.locator('.entry.similar').count(), 1);
      await right.locator('[data-entry-id="b1"] strong').click();
      assert.equal(await page.locator('.anchor-name').textContent(), '叙事基调');
      assert.equal(await right.locator('.entry').count(), 3);
    });
    await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true });
    await check('搜索正文和独有筛选', async () => {
      await page.getByRole('button', { name: '清除对比基准', exact: true }).click();
      await left.getByRole('searchbox').fill('藤蔓');
      await expect(left.locator('.entry')).toHaveCount(1);
      await left.getByRole('searchbox').fill('');
      await expect(left.locator('.entry')).toHaveCount(6);
      await page.getByRole('combobox', { name: '筛选', exact: true }).selectOption('only-right');
      assert.equal(await left.locator('.entry').count(), 0);
      assert.ok((await right.locator('.entry').count()) >= 2);
      await page.getByRole('combobox', { name: '筛选', exact: true }).selectOption('all');
    });
    await check('删除必须确认，可取消、撤销且不影响来源数据', async () => {
      await left.getByRole('button', { name: '春日场景 更多', exact: true }).click();
      await left.locator('[data-entry-id="a4"]').getByRole('button', { name: '删除…', exact: true }).click();
      const confirm = page.getByRole('alertdialog', { name: '删除条目' });
      await confirm.waitFor();
      await confirm.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await left.locator('[data-entry-id="a4"]').count(), 1);
      await left.getByRole('button', { name: '春日场景 更多', exact: true }).click();
      await left.locator('[data-entry-id="a4"]').getByRole('button', { name: '删除…', exact: true }).click();
      await confirm.getByRole('button', { name: '确定', exact: true }).click();
      assert.equal(await left.locator('[data-entry-id="a4"]').count(), 0);
      assert.equal(await page.evaluate(() => window.__PRW_DEMO_DATA__['preset:preset:春日来信'].raw.prompts.length), 7);
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      assert.equal(await left.locator('[data-entry-id="a4"]').count(), 1);
    });
    await check('多选插入成功清空勾选，来源自然顺序', async () => {
      await page.getByRole('combobox', { name: '操作模式' }).selectOption('insert');
      await left.getByRole('checkbox', { name: '选择 世界细节', exact: true }).check();
      await left.getByRole('checkbox', { name: '选择 对话节奏', exact: true }).check();
      await right.locator('[data-entry-id="b0"]').getByRole('button', { name: '前面', exact: true }).click();
      assert.equal(await left.locator('.entry input[type=checkbox]:checked').count(), 0);
      const names = await right.locator('.entry-top strong').allTextContents();
      assert.deepEqual(names.slice(0, 2), ['世界细节（副本）', '对话节奏（副本）']);
      await page.getByRole('button', { name: /^保存 ·/ }).click();
      assert.equal(await page.getByRole('button', { name: '已保存', exact: true }).count(), 1);
    });
    await check('分组选择清理二次确认、备份且不删条目', async () => {
      await left.getByRole('button', { name: '分组方案', exact: true }).click();
      const dialog = page.locator('.group-dialog');
      await dialog.getByRole('radio', { name: /^预设转移工具/ }).check();
      await dialog
        .locator('.source-card')
        .filter({ has: page.getByRole('radio', { name: /^柏宝箱/ }) })
        .getByRole('checkbox', { name: '清理这份记录' })
        .check();
      await dialog.getByRole('button', { name: '采用', exact: true }).click();
      await page
        .getByRole('alertdialog', { name: '清理分组记录' })
        .getByRole('button', { name: '确定', exact: true })
        .click();
      await page.getByRole('button', { name: /^保存 ·/ }).click();
      const saved = await page.evaluate(() => window.__PRW_DEMO_DATA__['preset:preset:春日来信']);
      assert.equal(saved.baibai, undefined);
      assert.equal(saved.raw.prompts.length, 7);
      assert.equal(saved.own.backups[0].provider, 'baibai');
    });
    await check('正则批量复制默认关闭且完整保留宏及扩展', async () => {
      await page.getByRole('button', { name: '正则', exact: true }).click();
      await right.locator('.resource-bar select').selectOption('regex:preset:春日来信');
      await page.getByRole('combobox', { name: '操作模式' }).selectOption('insert');
      await left.getByRole('checkbox', { name: '选择 折叠思考', exact: true }).check();
      await left.getByRole('checkbox', { name: '选择 称呼替换', exact: true }).check();
      await right.getByRole('button', { name: '插入末尾 · 2 条', exact: true }).click();
      assert.equal(await left.locator('.entry input[type=checkbox]:checked').count(), 0);
      await page.getByRole('button', { name: /^保存 ·/ }).click();
      const saved = await page.evaluate(() => window.__PRW_DEMO_DATA__['regex:preset:春日来信'].raw);
      assert.equal(saved.length, 3);
      assert.ok(saved.slice(1).every(r => r.disabled === true));
      assert.ok(saved.slice(1).every(r => r.substituteRegex === 2 && r.unknownField.keep === '完整保留'));
    });
    await check('拖动和插入互斥，多选拖动后清空选择', async () => {
      await page.getByRole('combobox', { name: '操作模式' }).selectOption('drag');
      assert.equal(await page.locator('.insert-actions').count(), 0);
      await left.getByRole('checkbox', { name: '选择 清理多余换行', exact: true }).check();
      await left.getByRole('checkbox', { name: '选择 移除提示标签', exact: true }).check();
      const payload = JSON.stringify({ key: 'regex:global', ids: ['r2', 'r4'] });
      const data = await page.evaluateHandle(value => {
        const dt = new DataTransfer();
        dt.setData('application/x-prw', value);
        return dt;
      }, payload);
      await right.locator('.entry').first().dispatchEvent('drop', { dataTransfer: data, offsetY: 0 });
      assert.equal(await left.locator('.entry input[type=checkbox]:checked').count(), 0);
      assert.ok((await right.locator('.entry-top strong').allTextContents()).includes('清理多余换行（副本）'));
    });
    await page.close();
    const preferences = await fresh();
    await check('通用入口在魔法棒、主题令牌与字体规则隔离', async () => {
      assert.equal(await preferences.locator('#extensions_settings2 .prw-open-button').count(), 0);
      assert.equal(await preferences.locator('#prw-wand-container .prw-wand-entry').count(), 1);
      await preferences.addStyleTag({ content: ':root{--SmartThemeBodyColor:rgb(36,70,92);--SmartThemeBlurTintColor:rgb(240,251,255);--SmartThemeQuoteColor:rgb(11,85,119)} :not([class*="fa-"]):not(.fa):not(.fas):not(.far):not(.fab):not(.fal):not(.fad){font-family:serif!important}' });
      const css = await preferences.locator('#prw-panel .prw-window').evaluate(e => ({ bg: getComputedStyle(e).backgroundColor, font: getComputedStyle(document.querySelector('#prw-panel .prw-brand-name')).fontFamily }));
      assert.equal(css.bg, 'rgb(240, 251, 255)');
      assert.ok(css.font.includes('851 GBai Marker'));
      await preferences.getByRole('button', { name: '外观', exact: true }).click();
      await preferences.getByRole('combobox', { name: '配色方式', exact: true }).selectOption('custom');
      await preferences.getByLabel('背景颜色', { exact: true }).fill('#ddeeff');
      await expect(preferences.locator('.prw-window')).toHaveCSS('background-color', 'rgb(221, 238, 255)');
      await preferences.getByRole('button', { name: '关闭外观', exact: true }).click();
    });
    await check('重复点击与重开保留预设、搜索、对比和自定义配色', async () => {
      const r = preferences.locator('.prw-column').nth(1);
      await r.locator('.resource-bar select').selectOption('preset:preset:旧城手记');
      await preferences.getByRole('button', { name: '预设', exact: true }).click();
      assert.equal(await r.locator('.resource-bar select').inputValue(), 'preset:preset:旧城手记');
      await preferences.getByRole('button', { name: '正则', exact: true }).click();
      await preferences.getByRole('button', { name: '预设', exact: true }).click();
      assert.equal(await r.locator('.resource-bar select').inputValue(), 'preset:preset:旧城手记');
      await preferences.locator('.prw-column').first().getByRole('searchbox').fill('藤蔓');
      await expect(preferences.locator('.prw-column').first().locator('.entry')).toHaveCount(1);
      await preferences.reload();
      await expect(preferences.locator('.prw-column').first().locator('.entry')).toHaveCount(1);
      assert.equal(await preferences.locator('.prw-column').nth(1).locator('.resource-bar select').inputValue(), 'preset:preset:旧城手记');
      await expect(preferences.locator('.prw-window')).toHaveCSS('background-color', 'rgb(221, 238, 255)');
      await preferences.getByRole('button', { name: '关闭', exact: true }).click();
      await preferences.locator('#prw-wand-container .prw-wand-entry').click();
      assert.equal(await preferences.locator('.segmented .active').textContent(), '预设');
      await preferences.getByRole('button', { name: '正则', exact: true }).click();
      await preferences.getByRole('button', { name: '关闭', exact: true }).click();
      await preferences.locator('#prw-wand-container .prw-wand-entry').click();
      assert.equal(await preferences.locator('.segmented .active').textContent(), '正则');
    });
    await preferences.close();
    const cancelNew = await fresh();
    await check('取消新增不留下空条目，完成新增可以撤销', async () => {
      const l = cancelNew.locator('.prw-column').first();
      await l.getByRole('button', { name: '添加条目', exact: true }).click();
      const prompt = cancelNew.getByRole('alertdialog');
      await prompt.locator('input').fill('新增检查');
      await prompt.getByRole('button', { name: '确定', exact: true }).click();
      await cancelNew.locator('.edit-dialog').getByRole('button', { name: '取消', exact: true }).click();
      await expect(l.locator('.entry')).toHaveCount(6);
      assert.equal(await cancelNew.getByRole('button', { name: /^保存 ·/ }).count(), 0);
      await l.getByRole('button', { name: '添加条目', exact: true }).click();
      await prompt.locator('input').fill('新增检查');
      await prompt.getByRole('button', { name: '确定', exact: true }).click();
      await cancelNew.locator('.edit-dialog').getByRole('button', { name: '完成', exact: true }).click();
      await expect(l.locator('.entry')).toHaveCount(7);
      await cancelNew.getByRole('button', { name: '撤销', exact: true }).click();
      await expect(l.locator('.entry')).toHaveCount(6);
    });
    await cancelNew.close();
    const native = await fresh();
    await check('原生更多菜单收纳、混合范围批量复制和旧入口去重', async () => {
      await native.getByRole('button', { name: '关闭', exact: true }).click();
      await native.evaluate(() => {
        const root = document.querySelector('#regex_container');
        root.style.display = 'block';
        const toolbar = document.createElement('div');
        toolbar.innerHTML =
          '<button id="th-regex-bulk-copy">旧复制</button><button id="bulk_export_regex">导出</button>';
        root.append(toolbar);
        for (const [id, type] of [
          ['r1', 'global'],
          ['cr1', 'scoped'],
        ]) {
          const row = document.createElement('div');
          row.id = id;
          row.className = 'regex-script-label';
          row.dataset.regexType = type;
          row.dataset.regexScriptId = id;
          row.innerHTML =
            '<input type="checkbox" class="regex_bulk_checkbox" checked><div><button class="th-regex-copy-button">旧复制</button><button class="edit_existing_regex">编辑</button><button class="export_regex">导出</button><button class="delete_regex">删除</button></div>';
          root.append(row);
        }
      });
      await native.locator('#regex_container .prw-row-more').first().waitFor();
      assert.equal(await native.locator('#regex_container .prw-row-more').count(), 2);
      assert.equal(await native.locator('#r1 .delete_regex').isVisible(), false);
      assert.equal(await native.locator('#r1 .th-regex-copy-button').isVisible(), false);
      assert.equal(await native.locator('#th-regex-bulk-copy').isVisible(), false);
      assert.equal(await native.locator('.prw-bulk-actions').isVisible(), true);
      await native.locator('#r1 .prw-row-more').click();
      await native.getByRole('menuitem', { name: '复制到… · 2 条', exact: true }).click();
      assert.equal(await native.locator('#prw-panel').count(), 0);
      await native.getByRole('dialog', { name: '复制到', exact: true }).getByRole('button', { name: '春日来信', exact: true }).click();
      await native.waitForFunction(() => window.__PRW_DEMO_DATA__['regex:preset:春日来信'].raw.length === 3);
      const saved = await native.evaluate(() => window.__PRW_DEMO_DATA__['regex:preset:春日来信'].raw);
      assert.equal(saved.length, 3);
      assert.deepEqual(
        saved.slice(1).map(r => r.scriptName),
        ['折叠思考（副本）', '角色对白（副本）'],
      );
      assert.ok(saved.slice(1).every(r => r.disabled));
      assert.equal(await native.locator('#prw-panel').count(), 0);
      assert.equal(await native.locator('.regex_bulk_checkbox:checked').count(), 0);
      await native.evaluate(() => window.__PRW__.destroy());
      assert.equal(await native.locator('#r1 .delete_regex').isVisible(), true);
      assert.equal(await native.locator('#th-regex-bulk-copy').isVisible(), true);
      assert.equal(await native.locator('.prw-row-more').count(), 0);
    });
    await native.close();
    const quick = await fresh();
    await quick.getByRole('button', {name:'关闭',exact:true}).click();
    await quick.evaluate(() => {
      document.querySelector('#openai_settings').style.display='block';
      const list=document.querySelector('#completion_prompt_manager_list');
      for(const id of ['a0','a1','a2']) {
        const row=document.createElement('li');row.className='completion_prompt_manager_prompt';row.dataset.pmIdentifier=id;
        row.innerHTML='<span class="completion_prompt_manager_prompt_name">'+id+'</span><span class="prompt_manager_prompt_controls"></span>';list.append(row);
      }
      const regex=document.querySelector('#regex_container');regex.style.display='block';
      for(const id of ['r1','r2']) {
        const row=document.createElement('div');row.className='regex-script-label';row.id=id;row.dataset.regexScriptId=id;row.dataset.regexType='global';
        row.innerHTML='<span class="regex_script_name">'+id+'</span><div><button class="edit_existing_regex">编辑</button><button class="delete_regex">删除</button></div>';regex.append(row);
      }
    });
    await quick.locator('#r1 .prw-row-more').waitFor();
    await check('原生复制默认在自身下方，选分组复制和移动均不打开对比界面', async () => {
      await quick.locator('#r1 .prw-row-more').click();
      await quick.getByRole('menuitem',{name:'复制',exact:true}).click();
      await quick.waitForFunction(()=>window.__PRW_DEMO_DATA__['regex:global'].raw.length===5);
      let raw=await quick.evaluate(()=>window.__PRW_DEMO_DATA__['regex:global'].raw);
      assert.equal(raw[0].id,'r1');assert.equal(raw[1].scriptName,'折叠思考（副本）');assert.equal(raw[1].disabled,true);assert.equal(raw[2].id,'r2');
      await quick.locator('#r1 .prw-row-more').click();
      await quick.getByRole('menuitem',{name:'复制到…',exact:true}).click();
      await quick.getByRole('dialog',{name:'复制到',exact:true}).getByRole('button',{name:'选择全局正则分组',exact:true}).click();
      await quick.getByRole('dialog',{name:'复制到',exact:true}).getByRole('button',{name:'显示整理',exact:true}).click();
      await quick.waitForFunction(()=>window.__PRW_DEMO_DATA__['regex:global'].raw.length===6);
      const grouped=await quick.evaluate(()=>window.__PRW_DEMO_DATA__['regex:global']);
      const newRegex=grouped.raw.find(r=>r.scriptName==='折叠思考（副本） 2');
      assert.equal(grouped.baibai.scripts[newRegex.id].groupId,'rg');
      await quick.locator('#r2 .prw-row-more').click();
      await quick.getByRole('menuitem',{name:'移动到…',exact:true}).click();
      await quick.getByRole('dialog',{name:'移动到',exact:true}).getByRole('button',{name:'角色 · 芙林',exact:true}).click();
      await quick.waitForFunction(()=>window.__PRW_DEMO_DATA__['regex:scoped:demo.png'].raw.length===2);
      assert.equal(await quick.evaluate(()=>window.__PRW_DEMO_DATA__['regex:global'].raw.some(r=>r.id==='r2')),false);
      assert.equal(await quick.locator('#prw-panel').count(),0);
      const icon=await quick.locator('#r1 .prw-row-more').evaluate(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,margin:getComputedStyle(e).margin,svg:!!e.querySelector('svg')}));
      assert.deepEqual(icon,{width:28,height:28,margin:'0px',svg:true});
    });
    await check('原生分组先选起点再选终点，就地命名并保留另一份分组', async () => {
      await quick.locator('[data-pm-identifier="a0"] .prw-row-more').click();
      await quick.getByRole('menuitem',{name:'分组',exact:true}).click();
      assert.equal(await quick.locator('.prw-range-start').count(),1);
      await quick.locator('[data-pm-identifier="a2"] .prw-row-more').click();
      await quick.getByRole('menuitem',{name:'设为终点',exact:true}).click();
      const naming=quick.getByRole('dialog',{name:'建立分组',exact:true});
      await naming.getByRole('combobox',{name:'分组方案',exact:true}).selectOption('baibai');
      await naming.getByLabel('组名',{exact:true}).fill('就地分组');
      await naming.getByRole('button',{name:'确定',exact:true}).click();
      await quick.waitForFunction(()=>window.__PRW_DEMO_DATA__['preset:preset:春日来信'].own?.groups.some(g=>g.name==='就地分组'));
      const saved=await quick.evaluate(()=>window.__PRW_DEMO_DATA__['preset:preset:春日来信']);
      assert.deepEqual(saved.own.groups.find(g=>g.name==='就地分组').members,['a0','a1','a2']);
      assert.ok(saved.transfer?.length);assert.equal(await quick.locator('#prw-panel').count(),0);
      assert.equal(await quick.locator('.prw-range-start').count(),0);
      await quick.getByRole('button',{name:'折叠 就地分组',exact:true}).click();
      await expect(quick.locator('[data-pm-identifier="a0"]')).toBeHidden();
      await quick.getByRole('button',{name:'展开 就地分组',exact:true}).click();
      await expect(quick.locator('[data-pm-identifier="a0"]')).toBeVisible();
    });
    await check('原生删除也需要就地确认，重新打开工坊读取最新数据', async () => {
      await quick.locator('[data-pm-identifier="a1"] .prw-row-more').click();
      await quick.getByRole('menuitem',{name:'删除…',exact:true}).click();
      let confirmation=quick.getByRole('dialog',{name:'删除条目',exact:true});
      await confirmation.getByRole('button',{name:'取消',exact:true}).click();
      assert.ok(await quick.evaluate(()=>window.__PRW_DEMO_DATA__['preset:preset:春日来信'].raw.prompts.some(e=>e.identifier==='a1')));
      await quick.locator('[data-pm-identifier="a1"] .prw-row-more').click();
      await quick.getByRole('menuitem',{name:'删除…',exact:true}).click();
      await confirmation.getByRole('button',{name:'确定',exact:true}).click();
      await quick.waitForFunction(()=>!window.__PRW_DEMO_DATA__['preset:preset:春日来信'].raw.prompts.some(e=>e.identifier==='a1'));
      await quick.locator('#prw-wand-container .prw-wand-entry').click();
      await expect(quick.locator('.prw-column').first().locator('[data-entry-id="a1"]')).toHaveCount(0);
      assert.ok((await quick.locator('#prw-panel').count())===1);
    });
    await check('手机原生快捷菜单不溢出，更多图标保持居中', async () => {
      await quick.getByRole('button',{name:'关闭',exact:true}).click();
      await quick.setViewportSize({width:320,height:844});
      await quick.addStyleTag({content:'.menu_button{margin:5px 0;line-height:50px;width:min-content}'});
      await quick.locator('#r1 .prw-row-more').click();
      await quick.getByRole('menuitem',{name:'复制到…',exact:true}).click();
      const rect=await quick.locator('.prw-quick-dialog').evaluate(e=>e.getBoundingClientRect().toJSON());
      assert.ok(rect.left>=0&&rect.right<=320,JSON.stringify(rect));
      const centered=await quick.locator('#r1 .prw-row-more').evaluate(e=>{const a=e.getBoundingClientRect(),b=e.querySelector('svg').getBoundingClientRect();return Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2)<1});
      assert.ok(centered);
      await quick.screenshot({path:path.join(out,'native-quick-mobile-320.png'),fullPage:true});
      await quick.getByRole('button',{name:'关闭快捷操作',exact:true}).click();
    });
    await quick.close();
    for (const width of [390, 320]) {
      const mobile = await fresh(width, 844);
      const l = mobile.locator('.prw-column').nth(0),
        r = mobile.locator('.prw-column').nth(1);
      await mobile.locator('.mobile-pages button').nth(1).click();
      await r.locator('.resource-bar select').selectOption('preset:preset:旧城手记');
      await check(`${width}px分页实际名称、独有筛选自动切页和无横向溢出`, async () => {
        const tabs = mobile.locator('.mobile-pages button');
        assert.deepEqual(await tabs.allTextContents(), ['春日来信', '旧城手记']);
        await mobile.getByRole('combobox', { name: '筛选', exact: true }).selectOption('only-right');
        assert.ok(await r.isVisible());
        assert.ok(!(await l.isVisible()));
        await mobile.getByRole('combobox', { name: '筛选', exact: true }).selectOption('only-left');
        assert.ok(await l.isVisible());
        assert.ok(!(await r.isVisible()));
        const overflow = await mobile.evaluate(() => ({
          width: innerWidth,
          document: document.documentElement.scrollWidth,
          panel: document.querySelector('#prw-panel').scrollWidth,
        }));
        assert.ok(overflow.document <= width && overflow.panel <= width, JSON.stringify(overflow));
        const titleBounds = await mobile.locator('#prw-panel .brand strong').evaluate(e => ({right:e.getBoundingClientRect().right, actions:document.querySelector('.header-actions').getBoundingClientRect().left}));
        assert.ok(titleBounds.right <= titleBounds.actions, JSON.stringify(titleBounds));
      });
      await mobile.screenshot({ path: path.join(out, `mobile-${width}.png`), fullPage: true });
      await mobile.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'ui-results.json'), JSON.stringify({ results, errors }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
