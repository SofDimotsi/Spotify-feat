const {chromium}=require('playwright');const assert=require('node:assert/strict');const fs=require('node:fs');
const base=process.env.APP_URL||'http://127.0.0.1:3000';fs.mkdirSync('/tmp/spotify-playback-check',{recursive:true});
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));let playing=true;let code=200;let fallback=false;
await page.route('https://api.spotify.com/**',r=>{
 if(code!==200)return r.fulfill({status:code,...(code===204?{}:{json:{error:{message:'Unavailable'}}})});
 if(fallback&&r.request().url().includes('/currently-playing'))return r.fulfill({status:204});
 return r.fulfill({json:{is_playing:playing,item:{name:'Same song',artists:[{name:'Same artist'}],external_urls:{spotify:'https://open.spotify.com'}}}});
});
await page.goto(base+'/app.html');await page.evaluate(()=>{spotifyAccessToken='fixture';loginBtn.style.display='none';setProfile({displayName:'Playback fixture'});proximitySection.classList.remove('hidden');});
await page.evaluate(()=>fetchCurrentTrack('fixture'));
assert.equal(await page.getByRole('status',{name:'Playback status: Playing'}).isVisible(),true);
await page.waitForFunction(()=>!document.querySelector('#status').classList.contains('is-revealing'));
await page.screenshot({path:'/tmp/spotify-playback-check/playing.png'});
playing=false;await page.evaluate(()=>fetchCurrentTrack('fixture'));
assert.equal(await page.getByRole('status',{name:'Playback status: Paused'}).isVisible(),true);
assert.equal(await page.locator('.track-title').innerText(),'Same song');
await page.screenshot({path:'/tmp/spotify-playback-check/paused.png'});
playing=true;fallback=true;await page.evaluate(()=>fetchCurrentTrack('fixture'));
assert.equal(await page.getByRole('status',{name:'Playback status: Playing'}).isVisible(),true);
code=403;await page.evaluate(()=>fetchCurrentTrack('fixture'));assert.equal(await page.locator('.playback-state').count(),0,'Errors must clear stale playing status.');
code=204;await page.evaluate(()=>fetchCurrentTrack('fixture'));assert.equal(await page.locator('.playback-state').count(),0);assert.match(await page.locator('.track-title').innerText(),/Nothing playing/);
code=200;fallback=false;playing=false;
for(const size of [{width:1280,height:800},{width:390,height:844},{width:667,height:375}]){
 await page.setViewportSize(size);await page.evaluate(()=>fetchCurrentTrack('fixture'));
 const fit=await page.evaluate(()=>({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight}));assert.ok(fit.w<=size.width&&fit.h<=size.height,JSON.stringify({size,fit}));
 assert.equal(await page.locator('.playback-state').isVisible(),true);
}
assert.deepEqual(errors,[]);console.log('PASS Playing → Paused → Playing on the same track; fallback status, error/empty clearing, responsive status visibility.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
