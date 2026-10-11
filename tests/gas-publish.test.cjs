const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('google-apps-script/Code.gs','utf8');
const headers = ['エリア','市町村名・開催地域','クライアント名','イベント名','カテゴリ','説明文','画像ファイル名','詳細URL','公開状態','表示順','画像代替テキスト'];
const row = overrides => Object.assign({'エリア':'北信','市町村名・開催地域':'長野市','クライアント名':'テスト','イベント名':'イベント','カテゴリ':'周遊型,Web型','説明文':'説明','画像ファイル名':'sample.jpg','詳細URL':'https://example.com/','公開状態':'公開','表示順':'10','画像代替テキスト':'会場'},overrides);
function server(rows = [row()],options = {}) {
  const props = new Map(Object.entries({SPREADSHEET_ID:'private-sheet',SHEET_NAME:'実績',IMAGE_FOLDER_ID:'private-folder',BUILD_API_TOKEN:'a'.repeat(40),CLOUDFLARE_DEPLOY_HOOK:'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/test'}));
  const properties = {getProperties:()=>Object.fromEntries(props),getProperty:key=>props.get(key) || null,setProperty:(key,value)=>props.set(key,value),deleteProperty:key=>props.delete(key)};
  const image = {getMimeType:()=>'image/jpeg',getSize:()=>3,getLastUpdated:()=>new Date(1000),getBlob:()=>({getBytes:()=>[1,2,3]})};
  const imageFiles = options.files || {'sample.jpg':[image]};
  const snapshots = new Map();
  const values = [['説明'],headers,...rows.map(item => headers.map(header => item[header]))];
  let posts = 0;
  let released = 0;
  let written;
  const context = vm.createContext({console:{log(){},error(){}},MimeType:{PLAIN_TEXT:'text/plain'},
    PropertiesService:{getScriptProperties:()=>properties},
    LockService:{getScriptLock:()=>({tryLock:()=>options.lock !== false,releaseLock:()=>{released++;}})},
    SpreadsheetApp:{flush(){},openById:()=>({getSheetByName:()=>({getDataRange:()=>({getDisplayValues:()=>values}),getRange:()=>({setValues:output=>{written=output;}})})})},
    DriveApp:{getFolderById:()=>({getFilesByName:name=>{
      const queue = [...(imageFiles[name] || [])];return {hasNext:()=>queue.length>0,next:()=>queue.shift()};
    },createFile:(name,json)=>{const id='snapshot-'+snapshots.size;snapshots.set(id,json);return {getId:()=>id};}}),
    getFileById:id=>({getBlob:()=>({getDataAsString:()=>snapshots.get(id)})})},
    Utilities:{base64Encode:bytes=>Buffer.from(bytes).toString('base64')},
    UrlFetchApp:{fetch:(url,args)=>{posts++;assert.equal(args.method,'post');if(options.networkError)throw new Error('secret URL must not leak');return {getResponseCode:()=>options.http || 200,getContentText:()=>JSON.stringify({success:true})};}},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})}
  });
  vm.runInContext(source,context);
  return {context,values,props,snapshots,image,get posts(){return posts;},get released(){return released;},get written(){return written;}};
}
test('snapshot excludes drafts, sorts rows, and stores bytes rather than live image links',() => {
  const s=server([row(),row({'イベント名':'先頭','表示順':'1'}),row({'イベント名':'秘密','公開状態':'下書き'})]);
  const result=s.context.captureSnapshot_();
  assert.equal(result.cases.length,2);
  assert.equal(result.cases[0].title,'先頭');
  assert.equal(result.images.length,1);
  assert.equal(result.images[0].base64,'AQID');
  assert.equal(JSON.stringify(result).includes('private-sheet'),false);
  assert.equal('sheetRow' in result.cases[0],false);
});
test('build request validates, saves immutable snapshot, sends one hook and guards double clicks',() => {
  const s=server();
  assert.equal(s.context.requestBuild_().count,1);
  assert.equal(s.posts,1);
  assert.equal(s.props.get('BUILD_SNAPSHOT_ID'),'snapshot-0');
  s.values[2][3]='変更後';
  const result=JSON.parse(s.context.doPost({postData:{contents:JSON.stringify({action:'export',token:'a'.repeat(40)})}}).text);
  assert.equal(result.cases[0].title,'イベント');
  assert.throws(()=>s.context.requestBuild_(),/1分/);
  assert.equal(s.posts,1);
  assert.equal(s.released,2);
});
test('no public GET data or unauthenticated snapshot access',() => {
  const s=server();s.context.requestBuild_();
  assert.equal(JSON.parse(s.context.doGet({}).text).ok,false);
  assert.equal(JSON.parse(s.context.doPost({postData:{contents:'{}'}}).text).error,'unauthorized');
  assert.equal(JSON.parse(s.context.doPost({postData:{contents:JSON.stringify({action:'export',token:'wrong'})}}).text).error,'unauthorized');
});
test('invalid input or invalid image prevents hook and snapshot creation',() => {
  for(const override of [{'エリア':'toString'},{'説明文':''},{'詳細URL':'javascript:alert(1)'},{'画像ファイル名':'../sample.jpg'},{'表示順':'不明'}]) {
    const s=server([row(override)]);assert.throws(()=>s.context.requestBuild_());assert.equal(s.posts,0);assert.equal(s.snapshots.size,0);
  }
  const base=server();
  for(const files of [{},{'sample.jpg':[base.image,base.image]},{'sample.jpg':[{...base.image,getSize:()=>900000}]}]) {
    const s=server([row()],{files});assert.throws(()=>s.context.requestBuild_());assert.equal(s.posts,0);
  }
});
test('Cloudflare rejection restores the previous snapshot; concurrent users cannot trigger a build',() => {
  const s=server(undefined,{http:500});s.props.set('BUILD_SNAPSHOT_ID','previous');
  assert.throws(()=>s.context.requestBuild_(),/受理しません/);
  assert.equal(s.props.get('BUILD_SNAPSHOT_ID'),'previous');
  assert.equal(s.props.has('LAST_BUILD_REQUEST_AT'),false);
  const concurrent=server(undefined,{lock:false});
  assert.throws(()=>concurrent.context.requestBuild_(),/別の担当者/);assert.equal(concurrent.posts,0);
});
test('all drafts produce a valid intentional empty publication',() => {
  const s=server([row({'公開状態':'下書き','説明文':''})]);
  assert.equal(s.context.requestBuild_().count,0);
});
test('ambiguous network failures keep the requested snapshot and never expose hook secrets',() => {
  const s=server(undefined,{networkError:true});s.props.set('BUILD_SNAPSHOT_ID','previous');
  assert.throws(()=>s.context.requestBuild_(),/ビルドが始まっている可能性/);
  assert.equal(s.props.get('BUILD_SNAPSHOT_ID'),'snapshot-0');
  assert.equal(s.props.get('LAST_BUILD_REQUEST_STATUS'),'応答未確認');
});
test('initial import refuses occupied sheets and writes twelve drafts into empty sheet',() => {
  const seed=fs.readFileSync('google-apps-script/InitialCases.gs','utf8');
  const occupied=server();vm.runInContext(seed,occupied.context);assert.throws(()=>occupied.context.importInitialCases(),/既存の入力/);
  const empty=server([]);vm.runInContext(seed,empty.context);empty.context.importInitialCases();
  assert.equal(empty.written.length,12);assert.ok(empty.written.every(item=>item[8]==='下書き'));
});
