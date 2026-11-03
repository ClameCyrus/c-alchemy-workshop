const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{chromium,expect}=require('@playwright/test');
const root=path.resolve(__dirname,'..'),out=path.join(root,'verification');
(async()=>{
  const channel=process.env.PRW_BROWSER_CHANNEL??(process.env.CI?'':'chrome');
  const browser=await chromium.launch({headless:true,...(channel?{channel}:{})}),results=[],errors=[],metrics={};
  const check=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name)};
  const p=await browser.newPage({viewport:{width:1400,height:900}});p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));
  try{
    fs.mkdirSync(out,{recursive:true});await p.route('https://**/*',r=>r.fulfill({status:200,body:''}));
    await p.goto(pathToFileURL(path.join(root,'preview.html')).href);await p.locator('.entry').first().waitFor();await p.evaluate(()=>window.__PRW__.destroy());
    await p.addScriptTag({path:require.resolve('jquery')});await p.addScriptTag({path:require.resolve('jquery-ui-dist/jquery-ui.js')});
    await p.evaluate(()=>{
      const d=window.__PRW_DEMO_DATA__['preset:preset:春日来信'],base=d.raw.prompts[0];
      d.raw.prompts=Array.from({length:329},(_,i)=>({...base,identifier:'a'+i,name:'原生提示词 '+i,content:'原生排序不改变正文。'.repeat(80)}));
      d.raw.prompt_order[0].order=d.raw.prompts.map((r,i)=>({identifier:r.identifier,enabled:i%3!==0,extra:'保留排序字段'}));
      d.own={version:1,native:true,sync:[],suppressed:[],groups:[{id:'g1',name:'原组',members:['a0','a1','a2'],collapsed:false,enabled:true},{id:'g2',name:'折叠组',members:['a3','a4'],collapsed:true,enabled:false},{id:'g3',name:'展开组',members:['a6','a7'],collapsed:false,enabled:true}]};
      window.__nativeEvents={load:0,commit:0,refresh:0,updates:0,saves:0,starts:0,stops:0};
      for(const key of ['load','commit','refresh']){const fn=window.__PRW_HOST__[key].bind(window.__PRW_HOST__);window.__PRW_HOST__[key]=async(...args)=>{window.__nativeEvents[key]++;return fn(...args)}}
      const container=document.querySelector('#openai_settings');container.style.cssText='display:block;width:460px;height:730px;overflow:auto;margin:12px;background:#1c2824';
      container.insertAdjacentHTML('afterbegin','<div class="completion_prompt_manager_header_advanced">预设条目</div>');
      const list=document.createElement('ul');list.id='completion_prompt_manager_list';list.style.cssText='padding:0;margin:0;list-style:none';document.querySelector('#completion_prompt_manager_list').replaceWith(list);
      const heading=document.createElement('li');heading.className='completion_prompt_manager_list_head';heading.textContent='名称';list.append(heading);
      d.raw.prompts.forEach(r=>{const li=document.createElement('li');li.className='completion_prompt_manager_prompt completion_prompt_manager_prompt_draggable';li.dataset.pmIdentifier=r.identifier;li.style.cssText='height:36px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #486';li.innerHTML=`<span class="drag-handle">☰</span><span class="completion_prompt_manager_prompt_name" style="flex:1">${r.name}</span><span class="prompt_manager_prompt_controls"><span class="prompt-manager-edit-action">✎</span><span class="prompt-manager-toggle-action">◉</span></span>`;list.append(li)});
      const update=(event,ui)=>{window.__nativeEvents.updates++;const data=window.__PRW_DEMO_DATA__['preset:preset:春日来信'];const old=new Map(data.raw.prompt_order[0].order.map(o=>[o.identifier,o]));const ids=window.jQuery(list).sortable('toArray',{attribute:'data-pm-identifier'});if(ids.length!==329||ids.some(id=>!old.has(id)))throw Error('原生排序收到无效ID');data.raw.prompt_order[0].order=ids.map(id=>old.get(id));window.__nativeEvents.saves++};
      window.jQuery(list).sortable({delay:50,items:'.completion_prompt_manager_prompt_draggable',handle:null,update,start:()=>window.__nativeEvents.starts++,stop:()=>window.__nativeEvents.stops++});
      window.__originalSortable=window.jQuery(list).data('ui-sortable');window.__originalUpdate=update;window.__originalRow=list.querySelector('[data-pm-identifier=a1]');window.__rawBefore=JSON.stringify(d.raw.prompts);
    });
    await p.addScriptTag({path:path.join(root,'dist/index.js')});await p.locator('#prw-panel .entry').first().waitFor();await p.getByRole('button',{name:'关闭',exact:true}).click();
    const list=p.locator('#completion_prompt_manager_list'),row=id=>list.locator(`[data-pm-identifier=${id}]`),header=id=>list.locator(`[data-group-id=${id}]`);
    await expect(list.locator('.prw-native-group-header')).toHaveCount(3);
    const counts=()=>p.evaluate(()=>({...window.__nativeEvents}));
    async function begin(id){const s=await row(id).locator('.drag-handle').boundingBox();await p.mouse.move(s.x+6,s.y+s.height/2);await p.mouse.down();await p.waitForTimeout(70);await p.mouse.move(s.x+20,s.y+s.height/2+8,{steps:3});await expect(list.locator('.ui-sortable-helper')).toHaveCount(1)}
    async function over(el,after=false){const t=await el.boundingBox();await p.mouse.move(t.x+80,after?t.y+t.height-3:t.y+5,{steps:8});await p.mouse.move(t.x+81,after?t.y+t.height-3:t.y+6);}
    const order=()=>p.evaluate(()=>window.__PRW_DEMO_DATA__['preset:preset:春日来信'].raw.prompt_order[0].order.map(o=>o.identifier));
    await check('329条原生预设使用原Sortable实例与update回调，拖动期间不重读重排',async()=>{
      await p.waitForTimeout(150);const before=await counts();await begin('a1');await over(row('a0'));
      await expect(p.locator('.prw-native-drop-line')).toBeVisible();await p.waitForTimeout(150);
      const during=await counts();assert.equal(during.load,before.load);assert.equal(during.commit,before.commit);assert.equal(during.refresh,before.refresh);
      assert.equal(await p.evaluate(()=>window.jQuery('#completion_prompt_manager_list').data('ui-sortable')===window.__originalSortable),true);
      assert.equal(await p.evaluate(()=>window.__originalSortable.options.update===window.__originalUpdate),true);
      assert.equal(await row('a1').evaluate(e=>e===window.__originalRow),true);
      await p.screenshot({path:path.join(out,'native-preset-insertion.png')});await p.mouse.up();
      assert.deepEqual((await order()).slice(0,3),['a1','a0','a2']);assert.equal((await counts()).updates,before.updates+1);assert.equal((await counts()).commit,before.commit);
    });
    await check('原生预设直接拖入折叠组，保留329项、正文、原开关与原排序字段',async()=>{
      const before=await counts();await begin('a1');await over(header('g2'));await p.mouse.up();
      await expect(row('a1')).toHaveAttribute('data-prw-group-id','g2');await expect(row('a1')).toHaveClass(/prw-group-folded/);
      assert.deepEqual((await order()).slice(0,6),['a0','a2','a3','a4','a1','a5']);const after=await counts();assert.equal(after.updates,before.updates+1);assert.equal(after.commit,before.commit+1);
      const d=await p.evaluate(()=>window.__PRW_DEMO_DATA__['preset:preset:春日来信']);assert.equal(d.raw.prompt_order[0].order.length,329);assert.ok(d.raw.prompt_order[0].order.every(o=>o.extra==='保留排序字段'&&o.enabled===(Number(o.identifier.slice(1))%3!==0)));
      assert.equal(await p.evaluate(()=>JSON.stringify(window.__PRW_DEMO_DATA__['preset:preset:春日来信'].raw.prompts)===window.__rawBefore),true);
      assert.ok(d.own.groups.find(g=>g.id==='g2').members.includes('a1'));assert.equal(d.own.groups.find(g=>g.id==='g2').enabled,false);
    });
    await check('从原生折叠组展开后拖到无组条目前后，实际退出分组',async()=>{
      await list.getByRole('button',{name:'展开 折叠组',exact:true}).click();await begin('a1');await over(row('a5'),true);await p.mouse.up();
      await expect(row('a1')).toHaveAttribute('data-prw-group-id','');assert.deepEqual((await order()).slice(0,6),['a0','a2','a3','a4','a5','a1']);
    });
    await check('直接拖到展开组普通条目的前后，原生占位符不会吞掉目标组归属',async()=>{
      await begin('a1');await over(row('a6'));await p.mouse.up();await expect(row('a1')).toHaveAttribute('data-prw-group-id','g3');
      assert.deepEqual((await order()).slice(0,8),['a0','a2','a3','a4','a5','a1','a6','a7']);
      await begin('a1');await over(row('a5'),true);await p.mouse.up();await expect(row('a1')).toHaveAttribute('data-prw-group-id','');
    });
    await check('Escape与拖到列表外取消不触发原生保存，也不提交分组',async()=>{
      for(const outside of [false,true]){const before=await counts(),ids=await order();await begin('a2');await over(header('g3'));
        if(outside){await p.mouse.move(900,800,{steps:4});await p.mouse.up()}else{await p.keyboard.press('Escape');await p.mouse.up()}
        await expect(list.locator('.ui-sortable-helper')).toHaveCount(0);await expect(p.locator('.prw-native-drop-line')).toHaveCount(0);assert.deepEqual(await order(),ids);const after=await counts();assert.equal(after.updates,before.updates);assert.equal(after.commit,before.commit);
      }
    });
    await check('条目锁开启后解锁及总开关关闭都能继续原生跨组拖动',async()=>{
      await p.evaluate(()=>window.__PRW__.open());await p.getByRole('button',{name:'设置',exact:true}).click();await p.getByRole('checkbox',{name:'启用预设条目锁'}).check();await p.getByRole('button',{name:'关闭外观'}).click();await p.getByRole('button',{name:'关闭',exact:true}).click();
      await p.getByRole('button',{name:'锁定预设排序'}).click();await expect(list).toHaveClass(/prw-preset-locked/);await p.getByRole('button',{name:'解锁预设排序'}).click();await begin('a2');await over(header('g3'));await p.mouse.up();await expect(row('a2')).toHaveAttribute('data-prw-group-id','g3');
      await p.evaluate(()=>window.__PRW__.open());await p.getByRole('button',{name:'设置',exact:true}).click();await p.getByRole('checkbox',{name:'启用预设条目锁'}).uncheck();await p.getByRole('button',{name:'关闭外观'}).click();await p.getByRole('button',{name:'关闭',exact:true}).click();
      await begin('a2');await over(header('g1'));await p.mouse.up();await expect(row('a2')).toHaveAttribute('data-prw-group-id','g1');
      assert.equal(await p.evaluate(()=>window.__originalSortable.options.update===window.__originalUpdate),true);
    });
    await check('保存失败会释放拖动冻结并明确提示，原生更新回调未被替换',async()=>{
      await p.evaluate(()=>{const h=window.__PRW_HOST__,original=h.commit;h.commit=async()=>{h.commit=original;throw Error('模拟分组保存失败')}});await begin('a2');await over(header('g3'));await p.mouse.up();
      await expect(p.locator('#prw-quick-root')).toContainText('分组归属保存失败');assert.equal(await p.evaluate(()=>window.__originalSortable.options.update===window.__originalUpdate),true);
      await p.getByRole('dialog',{name:'操作未完成',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();await begin('a2');await over(header('g3'));await p.mouse.up();await expect(row('a2')).toHaveAttribute('data-prw-group-id','g3');
    });
    await check('工坊存在草稿时阻止原生排序开始，关闭分组后仍保留原生拖动',async()=>{
      await p.evaluate(()=>{const s=document.querySelector('#prw-mount').__vue_app__.config.globalProperties.$pinia._s.get('preset-regex-workbench');s.documents[s.keys.left].dirty=true});
      const before=await counts(),ids=await order(),s=await row('a0').locator('.drag-handle').boundingBox();
      await p.mouse.move(s.x+5,s.y+5);await p.mouse.down();await p.waitForTimeout(70);await p.mouse.move(s.x+20,s.y+20);await p.mouse.up();
      await expect(p.getByRole('dialog',{name:'操作未完成',exact:true})).toContainText('未保存修改');assert.deepEqual(await order(),ids);assert.equal((await counts()).starts,before.starts);
      await p.getByRole('dialog',{name:'操作未完成',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
      await p.evaluate(()=>{const s=document.querySelector('#prw-mount').__vue_app__.config.globalProperties.$pinia._s.get('preset-regex-workbench');s.documents[s.keys.left].dirty=false;window.__PRW__.open()});
      await p.getByRole('button',{name:'设置',exact:true}).click();await p.getByRole('checkbox',{name:'启用分组功能',exact:true}).uncheck();await p.getByRole('button',{name:'关闭外观'}).click();await p.getByRole('button',{name:'关闭',exact:true}).click();await expect(list.locator('.prw-native-group-header')).toHaveCount(0);
      const plain=await counts();await begin('a2');await over(row('a0'));await p.mouse.up();assert.equal((await counts()).updates,plain.updates+1);assert.equal((await counts()).commit,plain.commit);
    });
    metrics.native=await counts();assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'native-preset-results.json'),JSON.stringify({results,metrics,errors},null,2));
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
