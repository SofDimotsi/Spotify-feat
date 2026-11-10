const {chromium}=require('playwright');const assert=require('node:assert/strict');const fs=require('node:fs');
const out=process.env.SCREENSHOT_DIR||'/tmp/spotify-hard-refresh';fs.mkdirSync(out,{recursive:true});
const base=process.env.APP_URL||'http://127.0.0.1:3000';const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:667,height:375}]){
 const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('spotify_access_token','fixture'));
 await page.route('**/api/events**',r=>r.fulfill({contentType:'text/event-stream',body:': fixture\n\n'}));
 await page.route('**/api/me',async r=>{await delay(100);await r.fulfill({json:{displayName:'Refresh fixture'}});});
 await page.route('https://api.spotify.com/**',async r=>{await delay(1000);await r.fulfill({json:{is_playing:true,item:{name:'Dreams',artists:[{name:'Fleetwood Mac'}],external_urls:{spotify:'https://open.spotify.com'}}}});});
 await page.route('**/api/chat/requests',r=>r.fulfill({json:{incoming:[],outgoing:[]}}));
 const cdp=await page.context().newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
 await page.goto(base+'/app.html');await page.waitForFunction(()=>!document.querySelector('.card').classList.contains('is-starting'));
 await cdp.send('Page.reload',{ignoreCache:true});await page.waitForEvent('domcontentloaded');
 await page.waitForFunction(()=>document.querySelector('#profile-name').textContent==='Refresh fixture');
 const early=await page.evaluate(()=>{
 const map=document.querySelector('.nearby-map').getBoundingClientRect();
 return {mapY:map.y,mapHeight:map.height,visible:['.app-header h1','#profile-name','.track-title','.proximity-header h2','#location-btn','.appearance-switch label','.map-legend span'].filter(s=>getComputedStyle(document.querySelector(s)).visibility!=='hidden'),scrollHeight:document.documentElement.scrollHeight};});
 assert.deepEqual(early.visible,[],'Content leaked through loading skeletons.');
 await page.screenshot({path:`${out}/loading-${viewport.width}x${viewport.height}.png`});
 await page.waitForFunction(()=>!document.querySelector('.card').classList.contains('is-starting')&&!document.querySelector('.card').classList.contains('is-startup-revealing'));
 const ready=await page.evaluate(()=>{const r=document.querySelector('.nearby-map').getBoundingClientRect();return {mapY:r.y,mapHeight:r.height,h:document.documentElement.scrollHeight,w:document.documentElement.scrollWidth};});
 assert.ok(Math.abs(ready.mapY-early.mapY)<1,JSON.stringify({viewport,early,ready}));
 assert.ok(Math.abs(ready.mapHeight-early.mapHeight)<1,JSON.stringify({viewport,early,ready}));
 assert.ok(ready.h<=viewport.height&&ready.w<=viewport.width);
 await page.screenshot({path:`${out}/ready-${viewport.width}x${viewport.height}.png`});
 assert.deepEqual(errors,[]);console.log(`PASS cache-disabled hard reload ${viewport.width}x${viewport.height}: no content leaks, <1px layout movement, no overflow or browser errors.`);
 await page.close();
}
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
