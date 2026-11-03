const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{chromium,expect}=require('@playwright/test');
const root=path.resolve(__dirname,'..'),out=path.join(root,'verification');
// The important global rules reproduce the theme collision without redistributing the user's theme.
const theme=`:root{--SmartThemeBlurTintColor:#fff8f0;--SmartThemeBodyColor:#343035;--SmartThemeQuoteColor:#cc668f;--SmartThemeBorderColor:#b7b4b0;--SmartThemeEmColor:#887d82}
select{background:#f9e2e7!important;color:#18181a!important;appearance:none!important;padding:3px 28px 3px 10px!important;border-radius:8px!important;box-shadow:inset 0 3px 5px #111!important;font-size:14px!important;min-height:24px!important}
*{border-radius:0!important}button{box-shadow:inset 0 0 4px #999!important;text-shadow:1px 1px #f9e2e7!important}input[type=checkbox]{appearance:none;width:14px;height:14px}input[type=checkbox]:checked::after{content:'X';position:absolute}`;
const codeTheme='pre::before{content:"decoration"}pre:hover{transform:translateY(-1px);box-shadow:0 0 10px pink}';
(async()=>{
  fs.mkdirSync(out,{recursive:true});const channel=process.env.PRW_BROWSER_CHANNEL??(process.env.CI?'':'chrome');
  const browser=await chromium.launch({headless:true,...(channel?{channel}:{})}),errors=[],results=[],metrics={};
  const check=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name)};
  const fresh=async(width=1440,height=940)=>{
    const p=await browser.newPage({viewport:{width,height}});p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));
    await p.route('https://**/*',r=>r.fulfill({status:200,body:''}));
    await p.goto(pathToFileURL(path.join(root,'preview.html')).href);await p.locator('.entry').first().waitFor();
    await p.addStyleTag({content:theme+codeTheme});
    if(process.env.PRW_THEME_FILE)await p.addStyleTag({path:process.env.PRW_THEME_FILE});return p;
  };
  try{
    const p=await fresh(),left=p.locator('.prw-column').first(),right=p.locator('.prw-column').nth(1);
    await right.locator('.resource-bar select').selectOption('preset:preset:旧城手记');
    await check('主题与自定义色下拉框都有原生箭头，尺寸一致且不被粉色覆盖',async()=>{
      await p.getByRole('combobox',{name:'操作模式'}).selectOption('drag');
      for(const mode of ['theme','custom']){
        await p.getByRole('button',{name:'设置',exact:true}).click();await p.getByRole('combobox',{name:'配色方式'}).selectOption(mode);await p.getByRole('button',{name:'关闭外观',exact:true}).click();
        const styles=await p.locator('#prw-panel select').evaluateAll(es=>es.map(e=>{const c=getComputedStyle(e);return{bg:c.backgroundColor,appearance:c.appearance,h:e.getBoundingClientRect().height,shadow:c.boxShadow}}));
        assert.ok(styles.every(s=>s.bg!=='rgb(249, 226, 231)'&&s.appearance==='auto'&&s.h===36&&s.shadow==='none'),JSON.stringify(styles));
        await expect(p.locator('.entry').first()).toHaveCSS('border-radius','10px');
        await p.screenshot({path:path.join(out,`theme-guard-${mode}.png`)});
      }
    });
    await check('受保护条目显示系统标识，普通条目仍可整行拖动',async()=>{
      await p.evaluate(()=>{const d=window.__PRW_DEMO_DATA__['preset:preset:春日来信'];d.raw.prompts[5].system_prompt=true;document.dispatchEvent(new Event('prw:resources-saved'))});
      await left.getByRole('button',{name:'重新载入',exact:true}).click();
      const item=left.locator('[data-entry-id=a5]');await expect(item.locator('.protected-tag')).toHaveText('系统');
      await expect(item).toHaveAttribute('draggable','false');await expect(item.locator('.drag-handle')).toHaveCount(0);await expect(item.locator('input')).toBeDisabled();
      await expect(left.locator('[data-entry-id=a0]')).toHaveAttribute('draggable','true');
      await p.getByRole('combobox',{name:'操作模式'}).selectOption('browse');
    });
    await check('候选侧换条目继续对比，基准侧换条目清空配对；正文显示设置差异',async()=>{
      await p.evaluate(()=>{const d=window.__PRW_DEMO_DATA__['preset:preset:旧城手记'];d.raw.prompts[1].role='user';d.raw.prompts[1].injection_depth=8;d.raw.prompts[1].injection_position=1});
      await right.getByRole('button',{name:'重新载入',exact:true}).click();
      await left.locator('[data-entry-id=a0] strong').click();await right.locator('[data-entry-id=b1] strong').click();
      await expect(p.locator('.settings-differences')).toHaveCount(2);await expect(p.locator('[data-side=right] .settings-differences')).toContainText('用户');
      assert.equal(await p.locator('.prw-text-reader pre').first().evaluate(e=>getComputedStyle(e,'::before').content),'none');
      await expect(p.locator('[data-side=right] .settings-differences')).toContainText('深度8');
      await p.getByRole('button',{name:'关闭正文对比'}).click();await right.locator('[data-entry-id=b0] strong').click();
      await expect(p.locator('.prw-text-reader')).toBeVisible();await expect(p.locator('.settings-differences')).toHaveCount(0);
      await p.getByRole('button',{name:'关闭正文对比'}).click();await left.locator('[data-entry-id=a1] strong').click();
      await expect(p.locator('.prw-text-reader')).toHaveCount(0);await expect(p.locator('.entry.anchor')).toHaveCount(1);await expect(p.locator('.anchor-name')).toHaveText('世界细节');
      await p.getByRole('button',{name:'清除对比基准'}).click();
    });
    await check('放弃紧邻保存且保留二次确认',async()=>{
      await left.locator('[data-entry-id=a0] .enabled-toggle').click();
      assert.equal(await p.locator('.discard-action').evaluate(e=>e.nextElementSibling.classList.contains('primary')),true);
      await p.locator('.discard-action').click();await expect(p.locator('.confirm-dialog')).toContainText('放弃所有未保存修改');await p.locator('.confirm-dialog').getByRole('button',{name:'取消'}).click();
      await expect(p.locator('.header-actions .primary')).toHaveText('保存 · 1');
    });
    for(const width of [390,320])await check(`${width}px手机含未保存状态不溢出，正文设置与页签完整可用`,async()=>{
      await p.setViewportSize({width,height:740});
      const geometry=await p.evaluate(()=>['#prw-panel','.prw-window','.prw-header','.prw-footer','.prw-toolbar'].map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return{s,x:r.x,y:r.y,right:r.right,bottom:r.bottom,sw:e.scrollWidth,w:e.clientWidth}}));
      assert.ok(geometry.every(r=>r.x>=-1&&r.y>=-1&&r.right<=width+1&&r.bottom<=741&&r.sw<=r.w+1),JSON.stringify(geometry));
      assert.equal(geometry[1].x,0);assert.equal(geometry[1].bottom,740);
      await p.screenshot({path:path.join(out,`mobile-theme-${width}.png`)});
      await p.locator('.mobile-pages button').first().click();await left.locator('[data-entry-id=a0] strong').click();await p.locator('.mobile-pages button').nth(1).click();await right.locator('[data-entry-id=b1] strong').click();
      const reader=p.locator('.prw-text-reader');await expect(reader).toBeVisible();assert.equal((await reader.boundingBox()).width,width);
      await expect(reader.locator('[data-side=right] .settings-differences')).toContainText('用户');
      await reader.locator('.reader-tabs button').first().click();await expect(reader.locator('[data-side=left] .settings-differences')).toContainText('系统');
      assert.ok(await reader.evaluate(e=>e.scrollWidth<=innerWidth));await p.screenshot({path:path.join(out,`mobile-settings-${width}.png`)});
      await p.getByRole('button',{name:'关闭正文对比'}).click();await p.getByRole('button',{name:'清除对比基准'}).click();
    });await p.close();

    const n=await fresh();await n.getByRole('button',{name:'关闭',exact:true}).click();
    await n.evaluate(()=>{
      const d=window.__PRW_DEMO_DATA__['regex:global'];d.raw=Array.from({length:95},(_,i)=>({...d.raw[0],id:'r'+i,scriptName:'正则 '+i,disabled:i%3===0,replaceString:'长正则正文'.repeat(5000)}));
      d.own={version:1,native:true,sync:[],suppressed:[],groups:[{id:'g1',name:'第一组',members:['r0','r1','r2'],enabled:true,collapsed:false},{id:'g2',name:'第二组',members:['r3','r4'],enabled:false,collapsed:false}]};
      const container=document.querySelector('#regex_container');container.style.cssText='display:block;max-width:420px;height:600px;overflow:auto;margin:12px';
      const root=document.querySelector('#saved_regex_scripts');root.innerHTML='';
      window.__nativeRows=new Map();window.__counts={load:0,commit:0,refresh:0,mousedown:0,toggle:0};
      for(const r of d.raw){const el=document.createElement('div');el.className='regex-script-label';el.dataset.regexScriptId=r.id;el.dataset.regexType='global';el.style.cssText='display:flex;align-items:center;gap:6px;height:44px;border-bottom:1px solid #aaa';el.innerHTML=`<span class="drag-handle">☷</span><span class="regex_script_name" style="flex:1">${r.scriptName}</span><label><input class="disable_regex" type="checkbox" ${r.disabled?'checked':''}></label><button class="edit_existing_regex">编辑</button>`;el.querySelector('input').addEventListener('change',()=>window.__counts.toggle++);root.append(el);window.__nativeRows.set(r.id,el)}
      root.addEventListener('mousedown',()=>window.__counts.mousedown++);
      for(const key of ['load','commit','refresh']){const original=window.__PRW_HOST__[key].bind(window.__PRW_HOST__);window.__PRW_HOST__[key]=async(...args)=>{window.__counts[key]++;const result=await original(...args);if(key==='refresh')for(const r of window.__PRW_DEMO_DATA__['regex:global'].raw)root.append(window.__nativeRows.get(r.id));return result}}
      document.dispatchEvent(new Event('prw:resources-saved'));
    });
    const list=n.locator('#saved_regex_scripts');await expect(list.locator('.prw-native-group-header')).toHaveCount(2);await n.waitForTimeout(200);
    const dragTo=async(id,target,after=false)=>{const s=await list.locator(`[data-regex-script-id=${id}] .regex_script_name`).boundingBox(),t=await target.boundingBox();await n.mouse.move(s.x+20,s.y+s.height/2);await n.mouse.down();await n.mouse.move(s.x+30,s.y+s.height/2+8,{steps:3});await n.mouse.move(t.x+40,after?t.y+t.height-3:t.y+3,{steps:8})};
    await check('原生正则拖动期间不反复重读/重绘，定位线可见且取消不保存',async()=>{
      const before=await n.evaluate(()=>({...window.__counts}));const start=Date.now();await dragTo('r1',list.locator('[data-regex-script-id=r4]'),true);
      await expect(n.locator('.prw-native-drop-line')).toBeVisible();await expect(list.locator('.prw-native-moving')).toHaveCount(1);await n.waitForTimeout(180);
      const during=await n.evaluate(()=>({...window.__counts}));assert.equal(during.load,before.load);assert.equal(during.commit,before.commit);assert.equal(during.mousedown,before.mousedown);
      assert.equal(await list.locator('[data-regex-script-id=r1]').evaluate(e=>e===window.__nativeRows.get('r1')),true);
      await n.screenshot({path:path.join(out,'native-regex-drop-line.png')});await n.keyboard.press('Escape');await n.mouse.up();
      await expect(n.locator('.prw-native-drop-line')).toHaveCount(0);assert.equal((await n.evaluate(()=>window.__counts)).commit,before.commit);metrics.dragObservationMs=Date.now()-start;
    });
    await check('原生正则跨组拖放只保存一次，改组归属及顺序且保留原开关',async()=>{
      await n.evaluate(()=>{const original=window.__PRW_HOST__.commit.bind(window.__PRW_HOST__);window.__PRW_HOST__.commit=async(...args)=>{window.__PRW_HOST__.commit=original;await new Promise(resolve=>window.__releaseCommit=resolve);return original(...args)}});
      const before=await n.evaluate(()=>({...window.__counts}));await dragTo('r1',list.locator('[data-regex-script-id=r4]'),true);await n.mouse.up();
      await expect.poll(()=>n.evaluate(()=>typeof window.__releaseCommit)).toBe('function');
      await dragTo('r2',list.locator('[data-regex-script-id=r4]'));await n.mouse.up();
      assert.equal(await n.evaluate(()=>window.__counts.mousedown),before.mousedown);
      await n.evaluate(()=>window.__releaseCommit());
      await expect.poll(()=>n.evaluate(()=>window.__counts.commit)).toBe(before.commit+1);await expect(n.locator('.prw-native-moving')).toHaveCount(0);
      const data=await n.evaluate(()=>window.__PRW_DEMO_DATA__['regex:global']);assert.deepEqual(data.raw.slice(0,6).map(x=>x.id),['r0','r2','r3','r4','r1','r5']);
      assert.ok(data.own.groups.find(g=>g.id==='g2').members.includes('r1'));assert.ok(!data.own.groups.find(g=>g.id==='g1').members.includes('r1'));
      assert.equal(data.raw.find(r=>r.id==='r1').disabled,false);assert.equal(data.raw.find(r=>r.id==='r0').disabled,true);
      await expect(list.locator('[data-regex-script-id=r1]')).toHaveAttribute('data-prw-group-id','g2');
      await expect(list.getByRole('button',{name:'启用 第二组',exact:true})).toBeVisible();
    });
    await check('拖到折叠组标题移入组末尾，拖出到普通条目取消组归属',async()=>{
      await list.getByRole('button',{name:'折叠 第一组',exact:true}).click();await expect(list.locator('[data-regex-script-id=r0]')).toHaveClass(/prw-group-folded/);await dragTo('r1',list.locator('[data-group-id=g1]'));await n.mouse.up();
      await expect(list.locator('[data-regex-script-id=r1]')).toHaveClass(/prw-group-folded/);
      await list.getByRole('button',{name:'展开 第一组',exact:true}).click();await dragTo('r1',list.locator('[data-regex-script-id=r5]'),true);await n.mouse.up();
      await expect(list.locator('[data-regex-script-id=r1]')).toHaveAttribute('data-prw-group-id','');
      assert.deepEqual(await n.evaluate(()=>window.__PRW_DEMO_DATA__['regex:global'].raw.slice(0,7).map(x=>x.id)),['r0','r2','r3','r4','r5','r1','r6']);
    });
    await check('原生开关继续使用原处理器；更多菜单在列表滚动时立即关闭',async()=>{
      await n.waitForTimeout(320);await list.locator('[data-regex-script-id=r1] .disable_regex').check();assert.equal(await n.evaluate(()=>window.__counts.toggle),1);
      await list.locator('[data-regex-script-id=r1] .prw-row-more').click();await expect(n.locator('.prw-native-menu')).toBeVisible();
      await n.locator('#regex_container').evaluate(e=>e.scrollTop+=100);await expect(n.locator('.prw-native-menu')).toHaveCount(0);
    });
    await check('原生长列表拖动到边缘会滚动，取消后无写入',async()=>{
      await n.locator('#regex_container').evaluate(e=>e.scrollTop=0);
      const before=await n.evaluate(()=>window.__counts.commit);const s=await list.locator('[data-regex-script-id=r2] .regex_script_name').boundingBox(),box=await n.locator('#regex_container').boundingBox();
      await n.mouse.move(s.x+20,s.y+5);await n.mouse.down();await n.mouse.move(box.x+70,box.y+box.height-12,{steps:10});
      await expect.poll(()=>n.locator('#regex_container').evaluate(e=>e.scrollTop)).toBeGreaterThan(40);
      await n.keyboard.press('Escape');await n.mouse.up();await expect(n.locator('.prw-native-drop-line')).toHaveCount(0);assert.equal(await n.evaluate(()=>window.__counts.commit),before);
    });
    await check('手机拖动手柄可触摸移入组，正常滑动正文不接管',async()=>{
      await n.setViewportSize({width:390,height:740});await n.locator('#regex_container').evaluate(e=>e.scrollTop=0);
      const cd=await n.context().newCDPSession(n),row=list.locator('[data-regex-script-id=r2]');
      const send=(type,x,y)=>cd.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y,id:1}]});
      const text=await row.locator('.regex_script_name').boundingBox();await send('touchStart',text.x+15,text.y+7);await send('touchMove',text.x+15,text.y+30);await send('touchEnd');
      await expect(n.locator('.prw-native-moving')).toHaveCount(0);await n.locator('#regex_container').evaluate(e=>e.scrollTop=0);
      const handle=await row.locator('.drag-handle').boundingBox(),target=await list.locator('[data-group-id=g2]').boundingBox();
      await send('touchStart',handle.x+5,handle.y+5);await send('touchMove',target.x+40,target.y+10);await expect(n.locator('.prw-native-drop-line')).toBeVisible();await send('touchEnd');
      await expect(row).toHaveAttribute('data-prw-group-id','g2');await cd.detach();await n.setViewportSize({width:1440,height:940});
    });
    await check('原生预设更多与编辑和开关居中对齐',async()=>{
      await n.evaluate(()=>{document.querySelector('#openai_settings').style.display='block';document.querySelector('#completion_prompt_manager_list').innerHTML='<div class="completion_prompt_manager_prompt" data-pm-identifier="a0" style="display:flex"><span>条目</span><span class="prompt_manager_prompt_controls" style="display:flex;align-items:baseline"><span class="prompt-manager-edit-action" style="height:18px;width:18px">✎</span><span class="prompt-manager-toggle-action" style="height:18px;width:18px">◉</span></span></div>'});
      await expect(n.locator('#completion_prompt_manager_list .prw-row-more')).toBeVisible();
      const centers=await n.locator('.prompt_manager_prompt_controls').evaluate(e=>[...e.children].map(c=>{const r=c.getBoundingClientRect();return r.y+r.height/2}));assert.ok(Math.max(...centers)-Math.min(...centers)<1,JSON.stringify(centers));
    });
    metrics.native=await n.evaluate(()=>window.__counts);await n.close();assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'theme-drag-results.json'),JSON.stringify({results,metrics,errors},null,2));
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
