const {chromium}=require('playwright');const assert=require('node:assert/strict');const fs=require('node:fs');
const base=process.env.APP_URL||'http://127.0.0.1:3000';const dir='/tmp/spotify-login-check';fs.mkdirSync(dir,{recursive:true});
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:320,height:568},{width:667,height:375}]){
 const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/app.html');
 assert.equal(await page.locator('.card').evaluate(e=>e.classList.contains('is-logged-out')),true);
 const geometry=await page.evaluate(()=>{const r=document.querySelector('.card').getBoundingClientRect(),b=document.querySelector('#login-btn').getBoundingClientRect();return {cardX:r.x,cardY:r.y,w:r.width,h:r.height,buttonCenter:b.x+b.width/2,pageW:document.documentElement.scrollWidth,pageH:document.documentElement.scrollHeight};});
 assert.ok(geometry.w<=460&&geometry.h<viewport.height);assert.ok(Math.abs(geometry.buttonCenter-viewport.width/2)<1);assert.ok(geometry.pageW<=viewport.width&&geometry.pageH<=viewport.height);
 const footer=await page.locator('.app-footer').evaluate(e=>{const r=e.getBoundingClientRect();return {right:r.right,bottom:r.bottom,top:r.top};});
 const inset=viewport.width<=700||viewport.height<=450?16:24;
 assert.ok(Math.abs(footer.right-(viewport.width-inset))<1);
 assert.ok(Math.abs(footer.bottom-(viewport.height-inset))<1);
 assert.ok(footer.top>=geometry.cardY+geometry.h,'Footer must stay outside the login card.');
 await page.screenshot({path:`${dir}/${viewport.width}x${viewport.height}.png`});
 let auth;
 await page.route('https://accounts.spotify.com/authorize?**',r=>{auth=new URL(r.request().url());return r.fulfill({body:'Spotify login fixture'});});
 await page.getByRole('button',{name:'Log in with Spotify',exact:true}).click();await page.waitForURL('https://accounts.spotify.com/authorize?**');
 assert.equal(auth.searchParams.get('response_type'),'code');assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.ok(auth.searchParams.get('code_challenge'));assert.deepEqual(errors,[]);
 await page.close();console.log(`PASS login layout ${viewport.width}x${viewport.height} and Spotify PKCE redirect.`);
}
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
