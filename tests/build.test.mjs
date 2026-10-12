import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {prepareSnapshot,renderPage,build} from '../scripts/build.mjs';

const row = overrides => ({region:'all',location:'長野市',client:'テスト',title:'新しい実績',type:'周遊型,Web型',description:'新しい説明',imageFile:'sample.jpg',url:'https://example.com/',...overrides});
const snapshot = cases => ({ok:true,version:1,cases:cases || [row()],images:[{name:'sample.jpg',mimeType:'image/jpeg',base64:'AQID'}]});
const template = await readFile(new URL('../index.html',import.meta.url),'utf8');

test('published cases populate the interactive card with local image URLs',() => {
  const data=prepareSnapshot(snapshot([row(),row({region:'south',title:'南信の実績'})]));
  const html=renderPage(template,data);
  assert.match(html,/<h3 id="caseMapTitle">新しい実績<\/h3>/);
  assert.match(html,/--case-image:url\('assets\/images\/cases\/[a-f0-9]+\.jpg'\)/);
  assert.equal(html.includes('掲載実績を一覧で見る'),false);
  assert.equal(data.assets.size,1);
  assert.equal(html.includes('OmonazoCasesAPI'),false);
  assert.equal(html.includes('script.google.com'),false);
  assert.equal(html.includes('信州・時空探偵団'),false);
  for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});

test('SEO crawl-control files are included in the generated site',async () => {
  await build({local:true});
  assert.match(await readFile(new URL('../dist/robots.txt',import.meta.url),'utf8'),/Sitemap: https:\/\/omonazo\.omomo-inc\.com\/sitemap\.xml/);
  assert.match(await readFile(new URL('../dist/sitemap.xml',import.meta.url),'utf8'),/<loc>https:\/\/omonazo\.omomo-inc\.com\/<\/loc>/);
  assert.deepEqual(
    await readFile(new URL('../dist/google4387c98ecfcc9677.html',import.meta.url)),
    await readFile(new URL('../google4387c98ecfcc9677.html',import.meta.url))
  );
});
test('HTML, attribute and script injection is escaped, including replacement dollar patterns',() => {
  const title='</script><script>alert(1)</script> $& "';
  const html=renderPage(template,prepareSnapshot(snapshot([row({title,description:'<img onerror=alert(1)>'})])));
  assert.equal(html.includes('</script><script>alert(1)'),false);
  assert.match(html,/&lt;img onerror=alert\(1\)&gt;/);
  assert.match(html,/\$&amp;/);
  for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});
test('unsafe URLs, missing images, unsupported MIME types and malformed base64 fail the build',() => {
  assert.throws(()=>prepareSnapshot(snapshot([row({url:'javascript:alert(1)'})])));
  const missing=snapshot();missing.images=[];assert.throws(()=>prepareSnapshot(missing));
  for(const mimeType of ['image/svg+xml','__proto__']) {
    const invalid=snapshot();invalid.images[0].mimeType=mimeType;assert.throws(()=>prepareSnapshot(invalid));
  }
  const invalid=snapshot();invalid.images[0].base64='??';assert.throws(()=>prepareSnapshot(invalid));
});
test('empty publication removes old cases and updates the initial HTML card',() => {
  const html=renderPage(template,prepareSnapshot({ok:true,version:1,cases:[],images:[]}));
  assert.match(html,/<h3 id="caseMapTitle">掲載準備中です<\/h3>/);
  assert.match(html,/id="caseMapCounter">0 \/ 0/);
  assert.equal(html.includes('信州・時空探偵団'),false);
});
test('image filenames depend on content, so same-name replacements invalidate CDN cache',() => {
  const first=prepareSnapshot(snapshot());
  const next=snapshot();next.images[0].base64='BAUG';
  assert.notEqual(first.cases[0].image,prepareSnapshot(next).cases[0].image);
});

test('production build exports only generated public assets and never includes build credentials',async () => {
  const originalFetch=globalThis.fetch;
  const originalURL=process.env.CASES_API_URL;
  const originalToken=process.env.CASES_BUILD_TOKEN;
  process.env.CASES_API_URL='https://script.google.com/macros/s/test/exec';
  process.env.CASES_BUILD_TOKEN='test-private-build-token-'.repeat(3);
  globalThis.fetch=async (url,options)=>{
    assert.equal(url,process.env.CASES_API_URL);
    assert.equal(options.method,'POST');
    assert.equal(JSON.parse(options.body).token,process.env.CASES_BUILD_TOKEN);
    return {ok:true,text:async()=>JSON.stringify(snapshot())};
  };
  try {
    await build();
    const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
    assert.equal(html.includes(process.env.CASES_BUILD_TOKEN),false);
    const image=html.match(/--case-image:url\('(assets\/images\/cases\/[a-f0-9]+\.jpg)'\)/)[1];
    assert.deepEqual(await readFile(new URL('../dist/'+image,import.meta.url)),Buffer.from([1,2,3]));
    await assert.rejects(readFile(new URL('../dist/google-apps-script/Code.gs',import.meta.url)));
    await assert.rejects(readFile(new URL('../dist/assets/images/case-nagano-jiku-detectives.jpg',import.meta.url)));
    // An export failure must preserve the last complete artifact.
    globalThis.fetch=async()=>({ok:true,text:async()=>'{"ok":false,"error":"unauthorized"}'});
    await assert.rejects(build());
    assert.equal(await readFile(new URL('../dist/index.html',import.meta.url),'utf8'),html);
  } finally {
    globalThis.fetch=originalFetch;
    if(originalURL === undefined)delete process.env.CASES_API_URL;else process.env.CASES_API_URL=originalURL;
    if(originalToken === undefined)delete process.env.CASES_BUILD_TOKEN;else process.env.CASES_BUILD_TOKEN=originalToken;
  }
});
