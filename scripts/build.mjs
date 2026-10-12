import {readFile,writeFile,mkdir,cp,mkdtemp,rename,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const regionNames = {all:'全県',north:'北信',central:'中信',east:'東信',south:'南信',other:'その他'};
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const safeJSON = value => JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
function validateURL(value) {
  if (!value) return '';
  const url = new URL(value);
  if (!['http:','https:'].includes(url.protocol)) throw new Error('詳細URLはhttp(s)のみ利用できます。');
  return url.href;
}

export function prepareSnapshot(snapshot,{local = false} = {}) {
  if (snapshot?.ok !== true || snapshot.version !== 1 || !Array.isArray(snapshot.cases) || snapshot.cases.length > 500 || !Array.isArray(snapshot.images)) {
    throw new Error('ビルド用データの形式が正しくありません。');
  }
  const assets = new Map();
  const filenames = new Map();
  let totalBytes = 0;
  snapshot.images.forEach(image => {
    const extension = new Map([['image/jpeg','jpg'],['image/png','png'],['image/webp','webp']]).get(image.mimeType);
    if (!extension || typeof image.name !== 'string' || filenames.has(image.name) || typeof image.base64 !== 'string' ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64) || image.base64.length % 4 !== 0) throw new Error('画像形式が正しくありません。');
    const bytes = Buffer.from(image.base64,'base64');
    totalBytes += bytes.length;
    if (!bytes.length || bytes.length > 800*1024 || totalBytes > 10*1024*1024) throw new Error('画像のサイズ制限を超えています。');
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0,24);
    const filename = `assets/images/cases/${hash}.${extension}`;
    assets.set(filename,bytes);
    filenames.set(image.name,filename);
  });
  const groups = Object.fromEntries(Object.keys(regionNames).map(key => [key,[]]));
  const cases = snapshot.cases.map(item => {
    if (!Object.hasOwn(groups,item.region) || !item.title?.trim() || !item.location?.trim() || !item.description?.trim()) throw new Error('公開実績に必須項目の不足があります。');
    const entry = {region:item.region};
    ['location','client','title','type','description','imageAlt'].forEach(key => {
      if (item[key] != null && typeof item[key] !== 'string') throw new Error('文字列の形式が正しくありません。');
      entry[key] = item[key] || '';
    });
    entry.url = validateURL(item.url);
    entry.image = '';
    if (item.imageFile) {
      if (!filenames.has(item.imageFile)) throw new Error('公開実績の画像がスナップショットにありません。');
      entry.image = filenames.get(item.imageFile);
    } else if (local && /^assets\/images\/case-[a-z0-9-]+\.jpg$/.test(item.image || '')) {
      entry.image = item.image;
    }
    groups[entry.region].push(entry);
    return entry;
  });
  return {cases,groups,assets};
}

function initialCard(groups) {
  const item = groups.all[0];
  const hasImage = Boolean(item?.image);
  const count = groups.all.length;
  const label = item?.imageAlt || `${item?.location || '全県'}の導入実績画像`;
  return `<article class="case-map-detail" aria-live="polite">
<button class="case-map-side-nav" type="button" id="caseMapPrev" aria-label="前の実績を見る"${count < 2 ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button>
<div class="case-map-detail-image${hasImage ? ' has-image' : ''}" id="caseMapImage" role="img" aria-label="${escapeHTML(label)}"${hasImage ? ` style="--case-image:url('${escapeHTML(item.image)}')"` : ''}><span>実績画像</span></div>
<div class="case-map-detail-copy"><div class="case-map-meta">
<span class="case-map-detail-label" id="caseMapLocation">${escapeHTML(item?.location || '全県')}</span>
<span class="case-map-detail-types" id="caseMapType"${item?.type ? '' : ' hidden'}>${(item?.type || '').split(/[,，]/).map(type => type.trim()).filter(Boolean).map(type => `<span class="case-map-detail-type">${escapeHTML(type)}</span>`).join('')}</span>
</div>
<span class="case-map-detail-client" id="caseMapClient"${item?.client ? '' : ' hidden'}>${escapeHTML(item?.client ? item.client.replace(/様$/,'') + '様' : '')}</span>
<h3 id="caseMapTitle">${escapeHTML(item?.title || '掲載準備中です')}</h3>
<p id="caseMapDescription">${escapeHTML(item?.description || 'このエリアの実績は順次追加します。')}</p>
<a class="case-map-external" id="caseMapLink"${item?.url ? ` href="${escapeHTML(item.url)}"` : ' hidden'} target="_blank" rel="noopener noreferrer">詳細はこちら<svg class="external-link-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M10 14 19 5M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg></a>
<div class="case-map-controls"><span class="case-map-counter" id="caseMapCounter">${count ? '1 / ' + count : '0 / 0'}</span></div></div>
<button class="case-map-side-nav" type="button" id="caseMapNext" aria-label="次の実績を見る"${count < 2 ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>
</article>`;
}

export function renderPage(template,prepared) {
  const substitutions = [
    [/let caseMapData = \{[\s\S]*?\n\};/,`let caseMapData = ${safeJSON(prepared.groups)};`],
    [/<article class="case-map-detail" aria-live="polite">[\s\S]*?<\/article>/,initialCard(prepared.groups)]
  ];
  let html = template;
  for (const [pattern,replacement] of substitutions) {
    if (!pattern.test(html)) throw new Error('HTMLテンプレートの実績領域が見つかりません。');
    html = html.replace(pattern,() => replacement);
  }
  return html;
}

async function localSnapshot() {
  const source = await readFile(path.join(root,'google-apps-script/InitialCases.gs'),'utf8');
  const seed = JSON.parse(source.match(/const seed = (\[[\s\S]*?\n\]);/)[1]);
  const regions = Object.fromEntries(Object.entries(regionNames).map(([key,value]) => [value,key]));
  return {ok:true,version:1,images:[],cases:seed.map(row => ({region:regions[row[0]],location:row[1],client:row[2],title:row[3],type:row[4],description:row[5],image:`assets/images/${row[6]}`,url:row[7],imageAlt:row[10]}))};
}

async function fetchSnapshot() {
  const endpoint = process.env.CASES_API_URL || '';
  const token = process.env.CASES_BUILD_TOKEN || '';
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(endpoint) || token.length < 32) {
    throw new Error('CASES_API_URL と CASES_BUILD_TOKEN をビルド環境に設定してください。');
  }
  let response;
  try {
    response = await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'export',token}),signal:AbortSignal.timeout(120000)});
  } catch (_) {
    throw new Error('Apps Scriptから公開データを取得できませんでした。');
  }
  if (!response.ok) throw new Error('Apps ScriptのHTTP応答が正常ではありません。');
  const text = await response.text();
  if (Buffer.byteLength(text) > 16*1024*1024) throw new Error('ビルド用データが大きすぎます。');
  let snapshot;
  try { snapshot = JSON.parse(text); } catch (_) { throw new Error('Apps ScriptがJSONを返していません。匿名アクセス・/exec・再デプロイを確認してください。'); }
  if (snapshot.ok !== true) throw new Error('保存済みの公開データを取得できません。トークン設定とシートのビルド操作を確認してください。');
  return snapshot;
}

export async function build({local = false} = {}) {
  if (local && process.env.CF_PAGES) throw new Error('Cloudflareではローカル見本データを公開できません。');
  const snapshot = local ? await localSnapshot() : await fetchSnapshot();
  const prepared = prepareSnapshot(snapshot,{local});
  const html = renderPage(await readFile(path.join(root,'index.html'),'utf8'),prepared);
  const temporary = await mkdtemp(path.join(root,'.build-'));
  try {
    await cp(path.join(root,'assets'),path.join(temporary,'assets'),{recursive:true,filter:source => local || !/^case-.*\.jpg$/.test(path.basename(source))});
    for (const filename of ['privacy-policy.html','site-footer.css','favicon.ico','robots.txt','sitemap.xml']) await cp(path.join(root,filename),path.join(temporary,filename));
    for (const [filename,bytes] of prepared.assets) {
      await mkdir(path.dirname(path.join(temporary,filename)),{recursive:true});
      await writeFile(path.join(temporary,filename),bytes);
    }
    await writeFile(path.join(temporary,'index.html'),html);
    await writeFile(path.join(temporary,'_headers'),'/assets/images/cases/*\n  Cache-Control: public, max-age=31536000, immutable\n/\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n');
    // Only generated output is replaced, after all data and images pass validation.
    await rm(path.join(root,'dist'),{recursive:true,force:true});
    await rename(temporary,path.join(root,'dist'));
  } catch (error) {
    await rm(temporary,{recursive:true,force:true});
    throw error;
  }
  console.log(`静的ビルド完了: 公開実績 ${prepared.cases.length}件${local ? '（ローカル確認用の既存データ）' : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build({local:process.argv.includes('--local')}).catch(error => { console.error(error.message); process.exitCode = 1; });
}
