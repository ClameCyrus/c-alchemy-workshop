const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');const {chromium,expect}=require('@playwright/test');
const root=path.resolve(__dirname,'..'),out=path.join(root,'verification');
(async()=>{
  const channel=process.env.PRW_BROWSER_CHANNEL??(process.env.CI?'':'chrome');
  const browser=await chromium.launch({headless:true,...(channel?{channel}:{})});
  const errors=[],results=[],metrics={};
  const fresh=async(width=1440,height=1000)=>{
    const p=await browser.newPage({viewport:{width,height}});p.on('pageerror',e=>errors.push(e.message));
    if(process.env.PRW_OFFLINE_TEST==='1')await p.route('https://fontsapi.zeoseven.com/**',r=>r.fulfill({status:200,contentType:'text/css',body:''}));
    await p.goto(pathToFileURL(path.join(root,'preview.html')).href);await p.locator('.entry').first().waitFor();return p;
  };
  const check=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name)};
  try {
    const p=await fresh(),left=p.locator('.prw-column').first(),right=p.locator('.prw-column').nth(1);
    await right.locator('.resource-bar select').selectOption('preset:preset:旧城手记');
    await check('双选打开大正文，统一关闭、保留选择、再点重开；单选不再挤底部',async()=>{
      await left.locator('[data-entry-id=a0] strong').click();
      await expect(p.locator('.prw-text-reader')).toHaveCount(0);await expect(p.locator('.detail-strip')).toHaveCount(0);
      await right.locator('[data-entry-id=b1] strong').click();
      await expect(p.getByRole('dialog',{name:'正文对比',exact:true})).toBeVisible();
      await expect(p.locator('.prw-text-reader pre')).toHaveCount(2);
      const text=await p.locator('.prw-text-reader pre').allTextContents();assert.ok(text.every(t=>t.length>40));
      await p.keyboard.press('Escape');await expect(p.locator('.prw-text-reader')).toHaveCount(0);await expect(p.locator('#prw-panel')).toBeVisible();
      await expect(p.locator('.entry.anchor')).toHaveCount(2);
      await right.locator('[data-entry-id=b1] strong').click();await expect(p.locator('.prw-text-reader')).toBeVisible();
      await p.getByRole('button',{name:'关闭正文对比',exact:true}).click();
    });
    await check('换预设立即清空对应数量和双选状态',async()=>{
      await expect(p.locator('.comparison-banner')).toBeVisible();
      await right.locator('.resource-bar select').selectOption('');
      await expect(p.locator('.comparison-banner')).toHaveCount(0);await expect(p.locator('.entry.anchor')).toHaveCount(0);
      await right.locator('.resource-bar select').selectOption('preset:preset:旧城手记');
      await expect(p.locator('.comparison-banner')).toHaveCount(0);
    });
    await check('主题额外边距不再造成顶部按钮错位',async()=>{
      await p.addStyleTag({content:'select{margin-bottom:5px;line-height:2}button{line-height:1.7}'});
      const geometry=await p.evaluate(()=>['.prw-toolbar','.resource-bar','.search-bar'].map(sel=>[...document.querySelector(sel).children].filter(e=>e.getBoundingClientRect().height&&e.matches('button,select,input,.segmented')).map(e=>({center:e.getBoundingClientRect().top+e.getBoundingClientRect().height/2,h:e.getBoundingClientRect().height}))));
      for(const row of geometry){assert.ok(Math.max(...row.map(r=>r.center))-Math.min(...row.map(r=>r.center))<1,JSON.stringify(row));assert.ok(row.every(r=>r.h===36),JSON.stringify(row));}
    });
    await check('整行真实鼠标多选拖动，前后线可见，准确落点且不误开正文',async()=>{
      await p.getByRole('combobox',{name:'操作模式'}).selectOption('drag');
      await left.getByRole('checkbox',{name:'选择 叙事基调',exact:true}).check();await left.getByRole('checkbox',{name:'选择 世界细节',exact:true}).check();
      const source=await left.locator('[data-entry-id=a0] strong').boundingBox(),target=await right.locator('[data-entry-id=b0]').boundingBox();
      await p.mouse.move(source.x+30,source.y+10);await p.mouse.down();await p.mouse.move(source.x+45,source.y+20,{steps:5});
      await p.mouse.move(target.x+100,target.y+10,{steps:10});await p.mouse.move(target.x+101,target.y+11);
      await expect(right.locator('[data-entry-id=b0]')).toHaveClass(/drop-before/);
      await expect(p.locator('.prw-text-reader')).toHaveCount(0);await expect(p.locator('.comparison-banner')).toHaveCount(0);
      await p.screenshot({path:path.join(out,'drag-insertion-line.png')});
      await p.mouse.move(target.x+100,target.y+target.height-10,{steps:3});await p.mouse.move(target.x+101,target.y+target.height-11);
      await expect(right.locator('[data-entry-id=b0]')).toHaveClass(/drop-after/);
      await p.mouse.up();
      await expect(left.locator('.entry input:checked')).toHaveCount(0);
      assert.deepEqual((await right.locator('.entry-top strong').allTextContents()).slice(0,3),['故事风格','叙事基调（副本）','世界细节（副本）']);
      await expect(p.locator('.drop-before,.drop-after,.drop-end')).toHaveCount(0);
    });
    await p.close();
    for(const width of [390,320]){
      const mobile=await fresh(width,844),l=mobile.locator('.prw-column').first(),r=mobile.locator('.prw-column').nth(1);
      await check(`${width}px正文全屏、实际预设名切换、统一关闭`,async()=>{
        await mobile.locator('.mobile-pages button').nth(1).click();await r.locator('.resource-bar select').selectOption('preset:preset:旧城手记');
        await mobile.locator('.mobile-pages button').first().click();await l.locator('[data-entry-id=a0] strong').click();
        await mobile.locator('.mobile-pages button').nth(1).click();await r.locator('[data-entry-id=b1] strong').click();
        const reader=mobile.locator('.prw-text-reader');await expect(reader).toBeVisible();
        assert.deepEqual(await reader.locator('.reader-tabs button').allTextContents(),['春日来信','旧城手记']);
        const rect=await reader.boundingBox();assert.equal(rect.width,width);assert.equal(rect.height,844);assert.equal(rect.x,0);
        await expect(reader.locator('[data-side=right]')).toBeVisible();await expect(reader.locator('[data-side=left]')).toBeHidden();
        await reader.locator('.reader-tabs button').first().click();await expect(reader.locator('[data-side=left]')).toBeVisible();
        assert.ok(await reader.evaluate(e=>e.scrollWidth<=innerWidth));
        await mobile.screenshot({path:path.join(out,`text-compare-${width}.png`)});
        await reader.getByRole('button',{name:'关闭正文对比',exact:true}).click();await expect(mobile.locator('#prw-panel')).toBeVisible();
      });await mobile.close();
    }
    const native=await fresh();await native.getByRole('button',{name:'关闭',exact:true}).click();
    await native.evaluate(()=>{
      const data=window.__PRW_DEMO_DATA__['regex:global'];
      data.raw=Array.from({length:95},(_,i)=>({...data.raw[0],id:'r'+i,scriptName:'原生正则 '+i,replaceString:'保留原开关和原生行。'.repeat(1800),disabled:i%3===0}));
      data.own={version:1,native:true,groups:[],sync:[],suppressed:[]};
      const root=document.querySelector('#saved_regex_scripts');document.querySelector('#regex_container').style.display='block';
      root.innerHTML='<div class="bai-bai-regex-group"><div class="bai-bai-regex-group-header">原插件组</div><div class="bai-bai-regex-group-body" aria-hidden="true" style="display:none"><div class="bai-bai-regex-group-body-inner"><div class="bai-bai-regex-group-list"></div></div></div></div>';
      const list=root.querySelector('.bai-bai-regex-group-list');window.__NATIVE_SWITCH_CALLS__=0;
      data.raw.forEach(r=>{const row=document.createElement('div');row.className='regex-script-label';row.dataset.regexScriptId=r.id;row.dataset.regexType='global';row.innerHTML=`<input type="checkbox" class="regex_bulk_checkbox"><span class="regex_script_name">${r.scriptName}</span><label><input type="checkbox" class="disable_regex" ${r.disabled?'checked':''}><span class="native-icon">原生开关</span></label><button class="edit_existing_regex">编辑</button><button class="delete_regex">删除</button>`;row.querySelector('.disable_regex').addEventListener('change',()=>window.__NATIVE_SWITCH_CALLS__++);list.append(row)});
      window.__ORIGINAL_NATIVE_ROW__=list.firstElementChild;window.__ORIGINAL_NATIVE_INPUT__=list.firstElementChild.querySelector('.disable_regex');
      window.__HOST_COUNTS__={load:0,commit:0,refresh:0,setGroupEnabled:0};
      for(const key of Object.keys(window.__HOST_COUNTS__)){const fn=window.__PRW_HOST__[key].bind(window.__PRW_HOST__);window.__PRW_HOST__[key]=(...args)=>{window.__HOST_COUNTS__[key]++;return fn(...args)}}
      document.dispatchEvent(new Event('prw:resources-saved'));
    });
    await check('空分组不改原列表、不增加未分组栏',async()=>{
      await native.waitForTimeout(250);await expect(native.locator('.prw-native-group-header')).toHaveCount(0);
      assert.equal(await native.locator('#saved_regex_scripts').evaluate(e=>e.classList.contains('prw-native-grouped')),false);
    });
    await native.evaluate(()=>{const data=window.__PRW_DEMO_DATA__['regex:global'];data.own.groups=[{id:'g',name:'测试组',members:data.raw.slice(0,50).map(r=>r.id),collapsed:false,enabled:true}];document.dispatchEvent(new Event('prw:resources-saved'))});
    await native.getByRole('button',{name:'折叠 测试组',exact:true}).waitFor();
    await check('95条长正则只增标题，原生行、复选框和事件保持身份',async()=>{
      await expect(native.locator('#saved_regex_scripts .regex-script-label:visible')).toHaveCount(95);
      await expect(native.locator('.prw-native-group-header')).toHaveCount(1);
      assert.equal(await native.locator('.prw-native-group-header').textContent(),'▾ 测试组  50停用');
      assert.equal(await native.evaluate(()=>document.querySelector('#saved_regex_scripts .regex-script-label')===window.__ORIGINAL_NATIVE_ROW__),true);
      assert.equal(await native.evaluate(()=>document.querySelector('#saved_regex_scripts .disable_regex')===window.__ORIGINAL_NATIVE_INPUT__),true);
      await native.locator('#saved_regex_scripts .disable_regex').first().uncheck();assert.equal(await native.evaluate(()=>window.__NATIVE_SWITCH_CALLS__),1);
    });
    await check('连续折叠不读取、不保存、不刷新正则，不弹更新通知',async()=>{
      await native.waitForTimeout(250);
      const result=await native.evaluate(async()=>{Object.keys(window.__HOST_COUNTS__).forEach(k=>window.__HOST_COUNTS__[k]=0);const before=JSON.stringify(window.__PRW_DEMO_DATA__['regex:global']);const button=document.querySelector('.prw-group-title');const times=[];for(let i=0;i<100;i++){const t=performance.now();button.click();times.push(performance.now()-t)}await new Promise(r=>setTimeout(r,250));return {counts:window.__HOST_COUNTS__,max:Math.max(...times),avg:times.reduce((a,b)=>a+b,0)/times.length,unchanged:JSON.stringify(window.__PRW_DEMO_DATA__['regex:global'])===before,notices:document.querySelectorAll('.prw-quick-notice').length}});
      assert.deepEqual(result.counts,{load:0,commit:0,refresh:0,setGroupEnabled:0});assert.equal(result.unchanged,true);assert.equal(result.notices,0);assert.ok(result.max<80,JSON.stringify(result));metrics.folding=result;
      await native.getByRole('button',{name:'折叠 测试组',exact:true}).click();await expect(native.locator('#saved_regex_scripts .regex-script-label:visible')).toHaveCount(45);
      await native.getByRole('button',{name:'展开 测试组',exact:true}).click();
    });
    await check('停用只更新组元数据，不重建行或修改原开关',async()=>{
      const before=await native.evaluate(()=>JSON.stringify(window.__PRW_DEMO_DATA__['regex:global'].raw));
      await native.getByRole('button',{name:'停用 测试组',exact:true}).click();await expect(native.getByRole('button',{name:'启用 测试组',exact:true})).toBeVisible();
      assert.equal(await native.evaluate(()=>JSON.stringify(window.__PRW_DEMO_DATA__['regex:global'].raw)),before);
      assert.deepEqual(await native.evaluate(()=>window.__HOST_COUNTS__),{load:0,commit:0,refresh:0,setGroupEnabled:1});
    });
    await check('原生分组只跟酒馆色，自定义配色局限工坊',async()=>{
      await native.addStyleTag({content:':root{--SmartThemeBodyColor:rgb(22,55,88);--SmartThemeQuoteColor:rgb(40,90,120);--SmartThemeBlurTintColor:rgb(240,245,250)}'});
      const original=await native.locator('.prw-native-group-header').evaluate(e=>getComputedStyle(e).color);
      await native.locator('.prw-wand-entry').click();await native.getByRole('button',{name:'设置',exact:true}).click();
      await native.getByRole('combobox',{name:'配色方式',exact:true}).selectOption('custom');await native.getByLabel('文字颜色',{exact:true}).fill('#ff0000');
      assert.equal(await native.locator('.prw-native-group-header').evaluate(e=>getComputedStyle(e).color),original);
      await expect(native.locator('.prw-window')).toHaveCSS('color','rgb(255, 0, 0)');
    });
    await check('关闭分组恢复原布局并保留记录，重新启用恢复标题',async()=>{
      const before=await native.evaluate(()=>JSON.stringify(window.__PRW_DEMO_DATA__['regex:global'].own));
      await native.getByRole('checkbox',{name:'启用分组功能',exact:true}).uncheck();await expect(native.locator('.prw-native-group-header')).toHaveCount(0);
      assert.equal(await native.locator('.bai-bai-regex-group-body').getAttribute('aria-hidden'),'true');
      assert.equal(await native.evaluate(()=>JSON.stringify(window.__PRW_DEMO_DATA__['regex:global'].own)),before);
      await native.getByRole('button',{name:'关闭外观',exact:true}).click();await expect(native.getByRole('button',{name:'分组方案',exact:true})).toHaveCount(0);
      await native.getByRole('button',{name:'设置',exact:true}).click();await native.getByRole('checkbox',{name:'启用分组功能',exact:true}).check();await expect(native.locator('.prw-native-group-header')).toHaveCount(1);
      await native.getByRole('button',{name:'关闭外观',exact:true}).click();await native.getByRole('button',{name:'关闭',exact:true}).click();
      await native.screenshot({path:path.join(out,'native-preserved-rows.png'),fullPage:true});
      await native.evaluate(()=>window.__PRW__.destroy());await expect(native.locator('.prw-native-group-header,.prw-group-folded,.prw-native-grouped')).toHaveCount(0);
      assert.equal(await native.evaluate(()=>document.querySelector('#saved_regex_scripts .disable_regex')===window.__ORIGINAL_NATIVE_INPUT__),true);
    });
    await native.close();assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'revision-results.json'),JSON.stringify({results,metrics,errors},null,2));
  } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
