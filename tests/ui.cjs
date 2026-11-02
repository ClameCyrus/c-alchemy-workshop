const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require('@playwright/test');
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
      assert.equal(await right.locator('.entry').count(), 3);
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
      assert.equal(await left.locator('.entry').count(), 1);
      await left.getByRole('searchbox').fill('');
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
      const nleft = native.locator('.prw-column').nth(0),
        nright = native.locator('.prw-column').nth(1);
      await nright.locator('.resource-bar select').selectOption('regex:preset:春日来信');
      await nright.getByRole('button', { name: '插入末尾 · 2 条', exact: true }).click();
      await native.getByRole('button', { name: /^保存 ·/ }).click();
      const saved = await native.evaluate(() => window.__PRW_DEMO_DATA__['regex:preset:春日来信'].raw);
      assert.equal(saved.length, 3);
      assert.deepEqual(
        saved.slice(1).map(r => r.scriptName),
        ['折叠思考（副本）', '角色对白（副本）'],
      );
      assert.ok(saved.slice(1).every(r => r.disabled));
      await native.evaluate(() => window.__PRW__.destroy());
      assert.equal(await native.locator('#r1 .delete_regex').isVisible(), true);
      assert.equal(await native.locator('#th-regex-bulk-copy').isVisible(), true);
      assert.equal(await native.locator('.prw-row-more').count(), 0);
    });
    await native.close();
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
