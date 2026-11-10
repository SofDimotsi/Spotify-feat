const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
const page=await browser.newPage();let calls=0,limited=true;
await page.route('https://api.spotify.com/**',r=>{calls++;return r.fulfill(limited?{status:429,headers:{'Retry-After':'30'},json:{error:{message:'Too many requests'}}}:{json:{is_playing:true,item:{name:'Recovered song',artists:[]}}});});
await page.goto((process.env.APP_URL||'http://127.0.0.1:3000')+'/app.html');await page.clock.install();
await page.evaluate(()=>fetchCurrentTrack('fixture'));assert.match(await page.locator('#status').innerText(),/rate limit \(429\)/);
await page.evaluate(()=>Promise.all([fetchCurrentTrack('fixture'),fetchCurrentTrack('fixture'),fetchCurrentTrack('fixture')]));assert.equal(calls,1,'Cooldown must prevent network retries.');
await page.reload();await page.evaluate(()=>fetchCurrentTrack('fixture'));assert.equal(calls,1,'Refresh must retain cooldown.');
limited=false;await page.clock.fastForward(31000);await page.evaluate(()=>fetchCurrentTrack('fixture'));assert.equal(calls,2);assert.match(await page.locator('#status').innerText(),/Recovered song/);
console.log('PASS 429 visibility, Retry-After backoff, cooldown across refresh, recovery.');
const restore=await browser.newPage();await restore.addInitScript(()=>{localStorage.setItem('spotify_access_token','fixture');localStorage.setItem('spotify_location_sharing','1');navigator.permissions.query=async()=>({state:'granted',onchange:null});navigator.geolocation.watchPosition=()=>42;});
await restore.route('**/api/events**',r=>r.fulfill({contentType:'text/event-stream',body:': fixture\n\n'}));await restore.route('**/api/me',r=>r.fulfill({json:{displayName:'Fixture'}}));await restore.route('**/api/chat/requests',r=>r.fulfill({json:{incoming:[],outgoing:[]}}));await restore.route('https://api.spotify.com/**',r=>r.fulfill({status:204}));
await restore.goto((process.env.APP_URL||'http://127.0.0.1:3000')+'/app.html');await restore.waitForFunction(()=>!document.querySelector('.card').classList.contains('is-starting'),{},{timeout:2000});assert.match(await restore.locator('#status').innerText(),/Nothing playing/);console.log('PASS stalled location restoration cannot block playback or hide errors.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
