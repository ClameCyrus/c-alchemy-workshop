const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{chromium,expect}=require('@playwright/test');
const root=path.resolve(__dirname,'..'),out=path.join(root,'verification');
(async()=>{
  const channel=process.env.PRW_BROWSER_CHANNEL??(process.env.CI?'':'chrome');
  const browser=await chromium.launch({headless:true,...(channel?{channel}:{})}),results=[],errors=[];
  const check=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name)};
  const fresh=async(width=1440,mobile=false)=>{
    const p=await browser.newPage({viewport:{width,height:844},isMobile:mobile,hasTouch:mobile});p.setDefaultTimeout(10000);
    p.on('pageerror',e=>errors.push(e.message));await p.route('https://**/*',r=>r.fulfill({status:200,body:''}));
    await p.goto(pathToFileURL(path.join(root,'preview.html')).href);await p.locator('.entry').first().waitFor();
    await p.addStyleTag({content:'nav,.nav-bar,header{background:#d9c8b4!important;box-shadow:0 0 4px pink!important;border-color:pink!important}dialog{max-width:75vw;padding:25px;border:8px solid red}'});
    if(process.env.PRW_THEME_FILE)await p.addStyleTag({path:process.env.PRW_THEME_FILE});return p;
  };
  try{
    const p=await fresh(),left=p.locator('.prw-column').first(),right=p.locator('.prw-column').nth(1);
    await check('工具栏容器隔离全局nav背景，自定义颜色覆盖到整个工具栏',async()=>{
      await p.getByRole('button',{name:'设置',exact:true}).click();await p.getByRole('combobox',{name:'配色方式'}).selectOption('custom');await p.getByLabel('背景颜色',{exact:true}).fill('#102030');await p.getByRole('button',{name:'关闭外观'}).click();
      await expect(p.locator('.prw-toolbar')).toHaveCSS('background-color','rgb(16, 32, 48)');
      await expect(p.locator('.prw-toolbar')).toHaveCSS('box-shadow','none');
      assert.equal(await p.locator('#prw-panel').evaluate(e=>e.matches(':modal')),true);
      await p.getByRole('button',{name:'设置',exact:true}).click();await p.getByLabel('背景颜色',{exact:true}).fill('#f0fbff');await p.getByRole('button',{name:'关闭外观'}).click();
    });
    await right.locator('.resource-bar select').selectOption('preset:preset:旧城手记');
    await check('再点同一基准取消筛选，候选切换仍维持一对多',async()=>{
      await left.locator('[data-entry-id=a0] strong').click();await expect(right.locator('.entry')).toHaveCount(3);
      await left.locator('[data-entry-id=a0] strong').click();await expect(right.locator('.entry')).toHaveCount(6);await expect(p.locator('.comparison-banner')).toHaveCount(0);
      await left.locator('[data-entry-id=a0] strong').click();await right.locator('[data-entry-id=b1] strong').click();await expect(p.locator('.prw-text-reader')).toBeVisible();
      await p.getByRole('button',{name:'关闭正文对比'}).click();await right.locator('[data-entry-id=b0] strong').click();await expect(p.locator('.prw-text-reader')).toBeVisible();
      await p.getByRole('button',{name:'关闭正文对比'}).click();await left.locator('[data-entry-id=a0] strong').click();await expect(p.locator('.comparison-banner')).toHaveCount(0);
    });
    await check('全部浏览默认内联展开分组，折叠不制造待保存改动，搜索显示组内匹配',async()=>{
      await p.evaluate(()=>{const d=window.__PRW_DEMO_DATA__['preset:preset:春日来信'];d.own={version:1,native:true,groups:[{id:'one',name:'行文',members:['a0','a1'],collapsed:true,enabled:true},{id:'two',name:'内容',members:['a3','a4'],collapsed:true,enabled:false}],sync:[],suppressed:[]}});
      await left.getByRole('button',{name:'重新载入'}).click();await expect(left.locator('.browse-group')).toHaveCount(2);await expect(left.locator('.entry')).toHaveCount(6);await expect(p.locator('.group-chips')).toHaveCount(0);
      assert.deepEqual(await left.locator('.entry-list').evaluate(e=>[...e.children].filter(n=>n.matches('.entry,.browse-group')).map(n=>n.matches('.browse-group')?'group':n.dataset.entryId)),['group','a0','a1','a2','group','a3','a4','a5']);
      await left.getByRole('button',{name:'折叠 行文',exact:true}).click();await expect(left.locator('.entry')).toHaveCount(4);await expect(p.locator('.header-actions .primary')).toHaveText('已保存');
      await left.getByRole('searchbox').fill('运河');await expect(left.locator('[data-entry-id=a1]')).toBeVisible();await expect(left.locator('.browse-group')).toHaveCount(1);
      await left.getByRole('searchbox').fill('');await expect(left.locator('.entry')).toHaveCount(4);
    });
    await check('全选名称与行为一致，含折叠组条目，单独勾选仍能多选',async()=>{
      await left.getByRole('button',{name:'全选',exact:true}).click();
      assert.equal(await p.evaluate(()=>document.querySelector('#prw-mount').__vue_app__.config.globalProperties.$pinia._s.get('preset-regex-workbench').selected['preset:preset:春日来信'].length),6);
      await left.getByRole('button',{name:'全选',exact:true}).click();await expect(left.locator('.entry input:checked')).toHaveCount(0);
      await left.getByRole('button',{name:'展开 行文',exact:true}).click();await left.getByRole('checkbox',{name:'选择 叙事基调',exact:true}).check();await left.getByRole('checkbox',{name:'选择 世界细节',exact:true}).check();await expect(left.locator('.entry input:checked')).toHaveCount(2);
      await left.getByRole('button',{name:'取消选择',exact:true}).click();
    });
    await check('保存先预览实际改动，取消或Escape保留草稿并保持工坊打开',async()=>{
      await left.locator('[data-entry-id=a0] .enabled-toggle').click();
      const before=await p.evaluate(()=>JSON.stringify(window.__PRW_DEMO_DATA__));await p.locator('.header-actions .primary').click();
      const review=p.getByRole('alertdialog',{name:'确认保存'});await expect(review).toContainText('修改「叙事基调」：条目开关：启用 → 停用');
      await expect(review.locator('header')).toHaveCSS('background-color','rgba(0, 0, 0, 0)');await expect(review.locator('header')).toHaveCSS('box-shadow','none');
      assert.equal(await p.evaluate(()=>JSON.stringify(window.__PRW_DEMO_DATA__)),before);
      await p.keyboard.press('Escape');await expect(review).toHaveCount(0);await expect(p.locator('#prw-panel')).toBeVisible();await expect(p.locator('.header-actions .primary')).toHaveText('保存 · 1');
      await p.locator('.header-actions .primary').click();await review.getByRole('button',{name:'取消'}).click();assert.equal(await p.evaluate(()=>JSON.stringify(window.__PRW_DEMO_DATA__)),before);
      await p.locator('.header-actions .primary').click();await review.getByRole('button',{name:'确定',exact:true}).click();await expect(p.locator('.header-actions .primary')).toHaveText('已保存');
    });
    await check('确认时草稿已变化则拒绝保存，重新确认后失败保留草稿可重试',async()=>{
      await left.locator('[data-entry-id=a1] .enabled-toggle').click();const before=await p.evaluate(()=>JSON.stringify(window.__PRW_DEMO_DATA__));await p.locator('.header-actions .primary').click();
      await p.evaluate(()=>{const s=document.querySelector('#prw-mount').__vue_app__.config.globalProperties.$pinia._s.get('preset-regex-workbench');s.documents[s.keys.left].entries[1].name='确认后变更'});
      await p.getByRole('alertdialog',{name:'确认保存'}).getByRole('button',{name:'确定',exact:true}).click();await expect(p.locator('.error-banner')).toContainText('改动已变化');assert.equal(await p.evaluate(()=>JSON.stringify(window.__PRW_DEMO_DATA__)),before);
      await p.evaluate(()=>{const h=window.__PRW_HOST__,original=h.commit;h.commit=async()=>{h.commit=original;throw Error('模拟保存失败')}});
      await p.locator('.header-actions .primary').click();await p.getByRole('alertdialog',{name:'确认保存'}).getByRole('button',{name:'确定',exact:true}).click();await expect(p.locator('.error-banner')).toContainText('模拟保存失败');await expect(p.locator('.header-actions .primary')).toHaveText('保存 · 1');
      await p.locator('.header-actions .primary').click();await p.getByRole('alertdialog',{name:'确认保存'}).getByRole('button',{name:'确定',exact:true}).click();await expect(p.locator('.header-actions .primary')).toHaveText('已保存');
    });
    await p.screenshot({path:path.join(out,'v011-inline-groups-desktop.png')});await p.close();

    const n=await fresh();await n.getByRole('button',{name:'关闭',exact:true}).click();
    await n.evaluate(()=>{
      document.querySelector('#openai_settings').style.display='block';const root=document.querySelector('#completion_prompt_manager_list');
      root.parentElement.insertAdjacentHTML('afterbegin','<div class="completion_prompt_manager_header_advanced">预设条目</div>');
      root.innerHTML='<li class="completion_prompt_manager_prompt completion_prompt_manager_prompt_draggable" data-pm-identifier="a0" draggable="true"><span class="completion_prompt_manager_prompt_name">测试条目</span><span class="prompt_manager_prompt_controls"><button class="prompt-manager-edit-action">编辑</button><button class="prompt-manager-toggle-action">开关</button></span></li>';
      const row=root.firstElementChild;window.__lockEvents={drag:0,edit:0,toggle:0};row.addEventListener('mousedown',()=>window.__lockEvents.drag++);row.querySelector('.prompt-manager-edit-action').addEventListener('click',()=>window.__lockEvents.edit++);row.querySelector('.prompt-manager-toggle-action').addEventListener('click',()=>window.__lockEvents.toggle++);
      window.__mockSortables=new WeakMap();const instance={disabled:false,option(key,value){if(arguments.length===1)return this[key];this[key]=value}};window.__mockSortables.set(root,instance);
      window.jQuery=el=>({data:key=>key==='ui-sortable'?window.__mockSortables.get(el):undefined});window.__originalLockedRow=row;
    });
    await check('条目锁总开关默认关闭，启用后原生排序可锁定且编辑开关可用',async()=>{
      await expect(n.locator('.prw-preset-lock')).toHaveCount(0);await n.evaluate(()=>window.__PRW__.open());await n.getByRole('button',{name:'设置',exact:true}).click();await n.getByRole('checkbox',{name:'启用预设条目锁',exact:true}).check();await n.getByRole('button',{name:'关闭外观'}).click();await n.getByRole('button',{name:'关闭',exact:true}).click();
      await n.getByRole('button',{name:'锁定预设排序',exact:true}).click();const row=n.locator('[data-pm-identifier=a0]');await expect(row).toHaveAttribute('draggable','false');assert.equal(await n.evaluate(()=>window.__mockSortables.get(document.querySelector('#completion_prompt_manager_list')).disabled),true);
      await row.locator('.completion_prompt_manager_prompt_name').click();assert.equal(await n.evaluate(()=>window.__lockEvents.drag),0);
      await row.locator('.prompt-manager-edit-action').click();await row.locator('.prompt-manager-toggle-action').click();assert.deepEqual(await n.evaluate(()=>[window.__lockEvents.edit,window.__lockEvents.toggle]),[1,1]);
      assert.equal(await row.evaluate(e=>e===window.__originalLockedRow),true);
    });
    await check('锁定后重绘继续锁住鸡尾酒拖动类，解锁及关闭总开关完整恢复',async()=>{
      await n.evaluate(()=>{const old=document.querySelector('[data-pm-identifier=a0]'),copy=old.cloneNode(true);copy.classList.add('completion_prompt_manager_prompt_draggable');copy.setAttribute('draggable','true');old.replaceWith(copy);window.__replacementRow=copy});
      await expect(n.locator('[data-pm-identifier=a0]')).toHaveAttribute('draggable','false');await expect(n.locator('[data-pm-identifier=a0]')).not.toHaveClass(/completion_prompt_manager_prompt_draggable/);
      await n.getByRole('button',{name:'解锁预设排序',exact:true}).click();await expect(n.locator('[data-pm-identifier=a0]')).toHaveAttribute('draggable','true');await expect(n.locator('[data-pm-identifier=a0]')).toHaveClass(/completion_prompt_manager_prompt_draggable/);
      assert.equal(await n.evaluate(()=>window.__mockSortables.get(document.querySelector('#completion_prompt_manager_list')).disabled),false);
      await n.getByRole('button',{name:'锁定预设排序',exact:true}).click();await n.evaluate(()=>window.__PRW__.open());await n.getByRole('button',{name:'设置',exact:true}).click();await n.getByRole('checkbox',{name:'启用预设条目锁',exact:true}).uncheck();await expect(n.locator('.prw-preset-lock')).toHaveCount(0);await expect(n.locator('[data-pm-identifier=a0]')).toHaveAttribute('draggable','true');assert.equal(await n.evaluate(()=>window.__mockSortables.get(document.querySelector('#completion_prompt_manager_list')).disabled),false);
      await n.getByRole('button',{name:'关闭外观'}).click();await n.getByRole('button',{name:'关闭',exact:true}).click();
    });
    await check('原本被其他插件禁用的排序不被解锁误启用，卸载清除功能',async()=>{
      await n.evaluate(()=>{window.__mockSortables.get(document.querySelector('#completion_prompt_manager_list')).disabled=true;window.__PRW__.open()});await n.getByRole('button',{name:'设置',exact:true}).click();await n.getByRole('checkbox',{name:'启用预设条目锁',exact:true}).check();await n.getByRole('button',{name:'关闭外观'}).click();await n.getByRole('button',{name:'关闭',exact:true}).click();
      await n.getByRole('button',{name:'解锁预设排序',exact:true}).click();assert.equal(await n.evaluate(()=>window.__mockSortables.get(document.querySelector('#completion_prompt_manager_list')).disabled),true);
      await n.evaluate(()=>window.__PRW__.destroy());await expect(n.locator('.prw-preset-lock,.prw-preset-locked')).toHaveCount(0);await expect(n.locator('[data-pm-identifier=a0]')).toHaveAttribute('draggable','true');
    });await n.close();
    for(const width of [390,320])await check(`${width}px真实触摸手机入口可从原生弹窗打开，反复关闭重开且无溢出`,async()=>{
      const m=await fresh(width,true);await m.getByRole('button',{name:'关闭',exact:true}).click();
      await m.evaluate(()=>{const d=document.createElement('dialog');d.id='native-mobile-popup';document.body.append(d);d.append(document.querySelector('#prw-wand-container'));d.showModal()});
      await m.locator('.prw-wand-entry').tap();await expect(m.locator('#prw-panel')).toBeVisible();assert.equal(await m.locator('#prw-panel').evaluate(e=>e.matches(':modal')),true);
      assert.equal(await m.evaluate(()=>!!document.elementFromPoint(innerWidth/2,100)?.closest('#prw-panel')),true);
      const bounds=await m.locator('.prw-window').boundingBox();assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=width&&bounds.y+bounds.height<=844,JSON.stringify(bounds));
      await m.getByRole('button',{name:'关闭',exact:true}).tap();await m.evaluate(()=>{document.querySelector('#native-mobile-popup').close();document.querySelector('#openai_settings').style.display='block'});
      for(let i=0;i<2;i++){await m.locator('#prw-preset-entry button').tap();await expect(m.locator('#prw-panel')).toBeVisible();await m.getByRole('button',{name:'关闭',exact:true}).tap()}
      await m.locator('#prw-preset-entry button').tap();await m.locator('.prw-column').first().locator('[data-entry-id=a0] .enabled-toggle').tap();await m.locator('.header-actions .primary').tap();await expect(m.getByRole('alertdialog',{name:'确认保存'})).toBeVisible();
      assert.ok(await m.locator('.confirm-dialog').evaluate(e=>e.getBoundingClientRect().right<=innerWidth&&e.scrollWidth<=e.clientWidth));await m.screenshot({path:path.join(out,`v011-mobile-entry-review-${width}.png`)});await m.close();
    });
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'v011-results.json'),JSON.stringify({results,errors},null,2));
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
