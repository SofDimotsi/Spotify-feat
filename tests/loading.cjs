const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const BASE = process.env.APP_URL || 'http://127.0.0.1:3000';
const output = process.env.SCREENSHOT_DIR || '/tmp/spotify-loading-check';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(output, {recursive:true});
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/events**',r=>r.fulfill({status:200,contentType:'text/event-stream',body:': fixture\n\n'}));
    await page.route('**/maps.googleapis.com/**',r=>r.abort());
    await page.goto(BASE+'/app.html');
    // Each scenario uses isolated fixture data, never the user's Spotify session.
    await page.evaluate(()=>{spotifyAccessToken='fixture';loginBtn.style.display='none';proximitySection.classList.remove('hidden');});
    let releaseProfile;
    const profileGate=new Promise(resolve=>releaseProfile=resolve);
    await page.route('**/api/me',async r=>{await profileGate;await r.fulfill({json:{displayName:'Fixture listener'}});});
    await page.evaluate(()=>{window.profileDone=loadMyProfile();});
    await page.waitForFunction(()=>document.querySelector('#profile-section').getAttribute('aria-busy')==='true');
    assert.equal(await page.locator('#profile-section').evaluate(e=>e.inert),true);
    await page.screenshot({path:output+'/profile-loading.png'});
    releaseProfile();await page.evaluate(()=>window.profileDone);
    assert.equal(await page.locator('#profile-section').getAttribute('aria-busy'),'false');
    assert.equal(await page.locator('#profile-section').evaluate(e=>e.inert),false);
    assert.match(await page.locator('#profile-name').innerText(),/Fixture/);
    console.log('PASS delayed profile: skeleton → content; busy and inert cleared.');

    let playbackCalls=0;
    await page.route('https://api.spotify.com/**',async r=>{playbackCalls++;await wait(180);await r.fulfill({status:204});});
    await page.evaluate(()=>{window.trackDone=Promise.all([fetchCurrentTrack('fixture'),fetchCurrentTrack('fixture')]);});
    await page.waitForFunction(()=>document.querySelector('#status').dataset.loadState==='loading');
    await page.evaluate(()=>window.trackDone);
    assert.equal(playbackCalls,2,'Concurrent calls should coalesce; 204 uses one fallback.');
    assert.match(await page.locator('#status').innerText(),/Nothing playing/);
    await page.evaluate(()=>{window.refreshDone=fetchCurrentTrack('fixture');});
    assert.equal(await page.locator('#status').getAttribute('aria-busy'),'false','Polling must preserve visible content.');
    await page.evaluate(()=>window.refreshDone);
    await page.unroute('https://api.spotify.com/**');
    await page.route('https://api.spotify.com/**',r=>r.fulfill({status:403,json:{error:{message:'Not allowed'}}}));
    await page.evaluate(()=>fetchCurrentTrack('fixture'));
    assert.match(await page.locator('#status').innerText(),/403/);
    assert.equal(await page.locator('#status').getAttribute('aria-busy'),'false');
    console.log('PASS empty playback, fallback, concurrent polling, error reveal, no refresh flicker.');

    await page.route('**/api/chat?**',async r=>{
      const user=new URL(r.request().url()).searchParams.get('withUserId');
      await wait(user==='old'?500:60);
      await r.fulfill({json:{messages:[{fromUserId:user,text:user+' message',sentAt:Date.now()}],canMessage:true}});
    });
    await page.evaluate(()=>{
      activeChatUserId='old';chatPanelEl.classList.remove('hidden');window.oldChat=loadChatMessages();
    });
    await page.waitForTimeout(30);
    await page.evaluate(()=>{activeChatUserId='new';window.newChat=loadChatMessages();});
    await page.evaluate(()=>Promise.all([window.oldChat,window.newChat]));
    assert.match(await page.locator('#chat-log').innerText(),/new message/);
    assert.doesNotMatch(await page.locator('#chat-log').innerText(),/old message/);
    assert.equal(await page.locator('#chat-log').getAttribute('aria-busy'),'false');
    await page.evaluate(()=>{activeChatUserId='old';window.closedChat=loadChatMessages();closeChatPanel();});
    await page.evaluate(()=>window.closedChat);
    assert.equal(await page.locator('#chat-log').innerText(),'');
    assert.equal(await page.locator('#chat-log').evaluate(e=>e.inert),false);
    console.log('PASS out-of-order chat responses and closing a panel mid-request.');

    await page.route('**/api/nearby?**',r=>r.fulfill({json:{people:[]}}));
    await page.evaluate(()=>{sharingEnabled=true;lastPosition={coords:{latitude:40.7,longitude:-74,accuracy:10}};return loadNearbyPeople();});
    await page.waitForFunction(()=>document.querySelector('#nearby-map').innerText.includes('Map unavailable'));
    assert.equal(await page.locator('#nearby-map').getAttribute('aria-busy'),'false');
    await page.evaluate(()=>clearNearbyList());
    assert.equal(await page.locator('#nearby-map').innerText(),'');
    console.log('PASS failed map script: readable error, no stuck skeleton, reset clears state.');

    await page.unroute('**/api/me');
    await page.route('**/api/me',r=>r.abort());
    await page.evaluate(async()=>{delete profileSection.dataset.loadedKey;try{await loadMyProfile();}catch{}});
    assert.match(await page.locator('#profile-name').innerText(),/unavailable/);
    assert.equal(await page.locator('#profile-section').getAttribute('aria-busy'),'false');
    console.log('PASS offline profile: error is visible and loader settles.');

    // A script that never finishes must time out, settle, and permit retry.
    await page.unroute('**/maps.googleapis.com/**');
    const held=[];
    await page.route('**/maps.googleapis.com/**',r=>{held.push(r);});
    await page.clock.install();
    await page.evaluate(()=>{sharingEnabled=true;lastPosition={coords:{latitude:40.7,longitude:-74,accuracy:10}};renderNearbyPeople([]);renderNearbyPeople([]);});
    await page.waitForFunction(()=>document.querySelector('#nearby-map').dataset.loadState==='loading');
    await page.clock.fastForward(16000);
    assert.equal(await page.locator('#nearby-map').getAttribute('aria-busy'),'false');
    assert.match(await page.locator('#nearby-map').innerText(),/Map unavailable/);
    assert.equal(held.length,1,'Repeated renders must share the script request.');
    for(const r of held)await r.abort();
    await page.unroute('**/maps.googleapis.com/**');
    await page.route('**/maps.googleapis.com/**',r=>r.fulfill({contentType:'application/javascript',body:`window.google={maps:{Map:class{constructor(el){el.innerHTML='<div>Fixture map ready</div>';}setCenter(){}setOptions(){}},Marker:class{setMap(){}},SymbolPath:{CIRCLE:0},MapTypeControlStyle:{DROPDOWN_MENU:0},ControlPosition:{TOP_RIGHT:0}}};`}));
    await page.evaluate(()=>renderNearbyPeople([]));
    await page.waitForFunction(()=>document.querySelector('#nearby-map').innerText.includes('Fixture map ready'));
    assert.equal(await page.locator('#nearby-map').getAttribute('aria-busy'),'false');
    console.log('PASS hanging map timeout, duplicate-script prevention, successful retry and empty listeners.');

    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(()=>{window.endReduced=beginPanelLoad(statusEl);});
    const motion=await page.locator('#status').evaluate(e=>({pulse:getComputedStyle(e,'::before').animationName,transition:getComputedStyle(e.firstElementChild).transitionDuration}));
    assert.equal(motion.pulse,'none');assert.equal(motion.transition,'0s');
    await page.evaluate(()=>window.endReduced());
    assert.equal(await page.locator('#status').getAttribute('aria-busy'),'false');
    console.log('PASS reduced motion: static placeholders and instant content.');

    // Check both loading and ready states at the smallest and widest breakpoints.
    for(const size of [{width:1440,height:900},{width:768,height:1024},{width:390,height:844},{width:320,height:568},{width:667,height:375}]){
      await page.setViewportSize(size);
      await page.evaluate(()=>{setProfile({displayName:'Fixture listener'});proximitySection.classList.remove('hidden');window.ends=[beginPanelLoad(profileSection),beginPanelLoad(statusEl),beginPanelLoad(nearbyMapEl)];});
      for(const state of ['loading','ready']){
        if(state==='ready')await page.evaluate(()=>window.ends.forEach(f=>f()));
        const fit=await page.evaluate(()=>({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight}));
        assert.ok(fit.w<=size.width&&fit.h<=size.height,JSON.stringify({size,state,fit}));
        await page.screenshot({path:`${output}/${state}-${size.width}x${size.height}.png`});
      }
    }
    await page.unroute('https://api.spotify.com/**');
    await page.route('https://api.spotify.com/**',r=>r.fulfill({status:401,json:{error:{message:'Expired'}}}));
    await page.evaluate(()=>fetchCurrentTrack('fixture'));
    assert.match(await page.locator('#status').innerText(),/Session expired/);
    assert.equal(await page.locator('#status').getAttribute('aria-busy'),'false');
    assert.equal(await page.locator('#login-btn').isVisible(),true);
    console.log('PASS expired session returns to login with no stuck loader.');
    const startupPage=await browser.newPage({viewport:{width:1280,height:800}});
    startupPage.on('pageerror',e=>errors.push(e.message));
    await startupPage.addInitScript(()=>localStorage.setItem('spotify_access_token','fixture'));
    await startupPage.route('**/api/events**',r=>r.fulfill({contentType:'text/event-stream',body:': fixture\n\n'}));
    await startupPage.route('**/api/me',async r=>{await wait(80);await r.fulfill({json:{displayName:'Startup fixture'}});});
    await startupPage.route('https://api.spotify.com/**',async r=>{await wait(500);await r.fulfill({status:204});});
    await startupPage.route('**/api/chat/requests',r=>r.fulfill({json:{incoming:[],outgoing:[]}}));
    await startupPage.goto(BASE+'/app.html');
    await startupPage.waitForFunction(()=>['#profile-section','#status'].every(s=>document.querySelector(s).getAttribute('aria-busy')==='true'));
    await startupPage.waitForFunction(()=>document.querySelector('#profile-name').textContent==='Startup fixture');
    assert.equal(await startupPage.locator('#profile-section').getAttribute('aria-busy'),'true','Fast profile must wait for playback.');
    assert.equal(await startupPage.locator('.proximity-controls-side').getAttribute('aria-busy'),'true','Nearby section joins the reveal.');
    await startupPage.evaluate(()=>{
      window.revealTimes={};
      new MutationObserver(records=>records.forEach(r=>{
        if(r.attributeName==='data-load-state'&&r.target.dataset.loadState==='ready')window.revealTimes[r.target.id]=performance.now();
      })).observe(document.querySelector('.card'),{subtree:true,attributes:true,attributeFilter:['data-load-state']});
    });
    await startupPage.screenshot({path:output+'/startup-loading.png'});
    await startupPage.waitForFunction(()=>['#profile-section','#status'].every(s=>document.querySelector(s).getAttribute('aria-busy')==='false'));
    const revealTimes=await startupPage.evaluate(()=>['profile-section','status','nearby-map'].map(id=>window.revealTimes[id]));
    assert.ok(revealTimes.every(Number.isFinite));
    assert.ok(Math.max(...revealTimes)-Math.min(...revealTimes)<16,'Panels must reveal in the same frame.');
    assert.match(await startupPage.locator('#profile-name').innerText(),/Startup fixture/);
    assert.match(await startupPage.locator('#status').innerText(),/Nothing playing/);
    await startupPage.close();
    console.log('PASS parallel startup: fast profile waits for slow playback; all panels reveal in the same frame.');
    assert.deepEqual(errors,[]);
    console.log('PASS loading/ready responsive screenshots at five sizes; zero uncaught browser errors.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
