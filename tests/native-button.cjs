const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{chromium,expect}=require('@playwright/test');
const root=path.resolve(__dirname,'..'),out=path.join(root,'verification');
(async()=>{
  const channel=process.env.PRW_BROWSER_CHANNEL??(process.env.CI?'':'chrome');
  const browser=await chromium.launch({headless:true,...(channel?{channel}:{})}),results=[],errors=[];
  const p=await browser.newPage({viewport:{width:1200,height:850}});p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));
  try{
    fs.mkdirSync(out,{recursive:true});await p.route(/^https?:/,r=>r.fulfill({status:200,body:''}));
    await p.goto(pathToFileURL(path.join(root,'preview.html')).href);await p.locator('.entry').first().waitFor();
    await p.getByRole('button',{name:'关闭',exact:true}).click();
    if(process.env.PRW_THEME_FILE)await p.addStyleTag({path:process.env.PRW_THEME_FILE});
    // Late global theme rules reproduce the reported filled button and cramped native controls.
    await p.addStyleTag({content:`body{margin:0!important}#preview-launch{display:none!important}
      #openai_settings{display:block!important;width:min(460px,100vw)!important;height:760px;overflow:auto!important;margin:0!important;padding:8px!important;box-sizing:border-box!important}
      #openai_settings #completion_prompt_manager_list{display:flex;flex-direction:column;padding:0;gap:6px;list-style:none}
      #completion_prompt_manager_list .completion_prompt_manager_prompt{display:flex;align-items:center;gap:4px;min-height:64px;padding:6px;box-sizing:border-box}
      #completion_prompt_manager_list .completion_prompt_manager_prompt_name{flex:1;white-space:normal}
      #completion_prompt_manager_list .prompt_manager_prompt_controls{width:42px;display:flex}
      #completion_prompt_manager_list .prompt_manager_prompt_controls>span{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center}
      #completion_prompt_manager_list button{background:pink!important;border:4px solid hotpink!important;box-shadow:2px 3px 6px #333!important;transform:translate(-6px,5px)!important;padding:16px!important;line-height:3!important}
      #completion_prompt_manager_list button svg{position:absolute!important;left:-8px!important;transform:translateY(8px)!important;width:34px!important;height:34px!important}
      #completion_prompt_manager_list .completion_prompt_manager_prompt_tokens{flex:0 0 12px}
      #regex_container{display:block!important;width:300px}`});
    await p.evaluate(()=>{
      document.body.dataset.stscriptStyle='theme';
      const list=document.querySelector('#completion_prompt_manager_list');
      const manager=document.createElement('div');manager.id='completion_prompt_manager';list.before(manager);manager.append(list);
      for(let i=0;i<12;i++){
        const row=document.createElement('li');row.className='completion_prompt_manager_prompt completion_prompt_manager_prompt_draggable';row.dataset.pmIdentifier='a'+i;
        row.innerHTML=`<span class="completion_prompt_manager_prompt_name">长标题原生提示词 · ${i} 保留原开关</span><span><span class="prompt_manager_prompt_controls"><span class="prompt-manager-edit-action" aria-label="原生编辑">✎</span><span class="prompt-manager-toggle-action" aria-label="原生开关">◉</span></span></span><span class="completion_prompt_manager_prompt_tokens">-</span>`;
        row.querySelector('.prompt-manager-toggle-action').onclick=()=>window.__toggleCalls=(window.__toggleCalls||0)+1;list.append(row);
      }
      const rx=document.querySelector('#saved_regex_scripts');rx.innerHTML='<div class="regex-script-label" id="r0"><span class="regex_script_name">正则</span><span><button class="edit_existing_regex">编辑</button></span></div>';
    });
    const row=p.locator('#completion_prompt_manager_list [data-pm-identifier=a0]');await row.locator('.prw-row-more').waitFor();
    for(const width of [1200,390,320]){
      await p.setViewportSize({width,height:850});await p.mouse.move(width-2,848);
      const report=await row.evaluate(row=>{
        const button=row.querySelector('.prw-row-more'),edit=row.querySelector('.prompt-manager-edit-action'),toggle=row.querySelector('.prompt-manager-toggle-action'),name=row.querySelector('.completion_prompt_manager_prompt_name');
        const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,right:r.right,y:r.y,bottom:r.bottom,w:r.width,h:r.height,cy:r.y+r.height/2}};
        const s=getComputedStyle(button);return{button:box(button),edit:box(edit),toggle:box(toggle),name:box(name),row:box(row),icon:box(button.querySelector('svg')),style:{border:s.borderWidth,shadow:s.boxShadow,transform:s.transform,bg:s.backgroundColor},menuClass:button.classList.contains('menu_button')};
      });
      assert.equal(report.menuClass,false);assert.equal(report.style.border,'0px');assert.equal(report.style.shadow,'none');assert.equal(report.style.transform,'none');assert.equal(report.style.bg,'rgba(0, 0, 0, 0)');
      assert.equal(report.button.w,28);assert.equal(report.button.h,28);assert.equal(report.icon.w,16);assert.equal(report.icon.h,16);
      assert.ok(report.name.right<=report.edit.x+1&&report.edit.right<=report.toggle.x+1&&report.toggle.right+3<=report.button.x,JSON.stringify(report));
      assert.ok(Math.abs(report.button.cy-report.toggle.cy)<1&&Math.abs(report.button.cy-report.edit.cy)<1,JSON.stringify(report));
      assert.ok(report.button.right<=report.row.right&&report.row.right<=width&&report.icon.x>=report.button.x&&report.icon.right<=report.button.right,JSON.stringify(report));
      await row.getByLabel('原生开关').click();await row.getByRole('button',{name:'更多'}).click();await expect(p.locator('.prw-native-menu')).toBeVisible();
      await p.locator('#openai_settings').evaluate(e=>e.scrollTop=40);await expect(p.locator('.prw-native-menu')).toHaveCount(0);await p.locator('#openai_settings').evaluate(e=>e.scrollTop=0);
      results.push(`${width}px原生更多按钮抵抗主题样式、居中且不重叠，原生开关与滚动关闭正常`);console.log('PASS '+results.at(-1));
      await p.screenshot({path:path.join(out,`native-button-${process.env.PRW_THEME_FILE?'live-':''}${width}.png`)});
    }
    assert.equal(await p.evaluate(()=>window.__toggleCalls),3);await expect(p.locator('#regex_container .prw-row-more')).toHaveCSS('width','28px');
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,process.env.PRW_THEME_FILE?'native-button-theme-results.json':'native-button-results.json'),JSON.stringify({results,errors},null,2));
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
