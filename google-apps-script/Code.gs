/** Manual publishing from the bound Sheet. Only the token-protected build API is public. */
const CASES_HEADERS = ['エリア','市町村名・開催地域','クライアント名','イベント名','カテゴリ','説明文','画像ファイル名','詳細URL','公開状態','表示順','画像代替テキスト'];
const CASES_REGIONS = {'全県':'all','北信':'north','東信':'east','中信':'central','南信':'south','その他':'other'};
const CASES_IMAGE_LIMIT = 800 * 1024;
const CASES_TOTAL_IMAGE_LIMIT = 10 * 1024 * 1024;

function doGet(e) {
  // Sheet edits and private Drive images are never exposed through a public GET.
  return jsonOutput_({ok:false,error:'use_authenticated_build_api'});
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('BUILD_API_TOKEN');
    if (!token || token.length < 32 || body.token !== token || body.action !== 'export') {
      return jsonOutput_({ok:false,error:'unauthorized'});
    }
    const id = props.getProperty('BUILD_SNAPSHOT_ID');
    if (!id) return jsonOutput_({ok:false,error:'no_snapshot'});
    const snapshot = JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8'));
    return jsonOutput_(snapshot);
  } catch (error) {
    console.error('ビルド用スナップショットの取得に失敗しました。');
    return jsonOutput_({ok:false,error:'temporarily_unavailable'});
  }
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function getSettings_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  if (!props.SPREADSHEET_ID || !props.IMAGE_FOLDER_ID || !props.SHEET_NAME) {
    throw new Error('SPREADSHEET_ID、IMAGE_FOLDER_ID、SHEET_NAME をスクリプトプロパティに設定してください。');
  }
  return props;
}

function getSheet_() {
  const settings = getSettings_();
  const sheet = SpreadsheetApp.openById(settings.SPREADSHEET_ID).getSheetByName(settings.SHEET_NAME);
  if (!sheet) throw new Error('指定したシートがありません。');
  return sheet;
}

function readRows_() {
  const values = getSheet_().getDataRange().getDisplayValues();
  const headerIndex = values.findIndex(row => row.includes('イベント名') && row.includes('画像ファイル名'));
  if (headerIndex < 0) throw new Error('見出し行が見つかりません。既存テンプレートをインポートしてください。');
  const headers = values[headerIndex].map(value => value.trim());
  CASES_HEADERS.forEach(header => {
    if (headers.indexOf(header) < 0) throw new Error('必須列がありません: ' + header);
    if (headers.indexOf(header) !== headers.lastIndexOf(header)) throw new Error('列名が重複しています: ' + header);
  });
  return values.slice(headerIndex + 1).map((values,index) => {
    const row = {sheetRow:headerIndex + index + 2};
    CASES_HEADERS.forEach(header => { row[header] = (values[headers.indexOf(header)] || '').trim(); });
    return row;
  });
}

function parseCases_(rows) {
  const cases = [];
  rows.forEach(row => {
    if (row['公開状態'] !== '公開') return;
    const fail = message => { throw new Error(row.sheetRow + '行目: ' + message); };
    const region = CASES_REGIONS[row['エリア']];
    if (!region || !['全県','北信','東信','中信','南信','その他'].includes(row['エリア'])) fail('エリアを選択してください。');
    ['イベント名','市町村名・開催地域','説明文'].forEach(key => {
      if (!row[key]) fail(key + 'が空欄です。');
      if (row[key].length > 4000) fail(key + 'は4000文字以下にしてください。');
    });
    const filename = row['画像ファイル名'];
    if (filename && (filename.length > 200 || /[\/\\\u0000-\u001f]/.test(filename) || !/\.(jpg|jpeg|png|webp)$/i.test(filename))) {
      fail('画像ファイル名は JPG・PNG・WebP のファイル名を指定してください。');
    }
    const url = row['詳細URL'];
    if (url && (!/^https?:\/\/[^\s]+$/i.test(url) || /[<>"']/.test(url))) fail('詳細URLは http(s) URL を指定してください。');
    const order = row['表示順'] === '' ? row.sheetRow : Number(row['表示順']);
    if (!Number.isFinite(order)) fail('表示順は半角数字を指定してください。');
    cases.push({
      region,location:row['市町村名・開催地域'],client:row['クライアント名'],title:row['イベント名'],
      type:row['カテゴリ'],description:row['説明文'],imageFile:filename,imageAlt:row['画像代替テキスト'],url,
      order,sheetRow:row.sheetRow
    });
  });
  if (cases.length > 500) throw new Error('公開実績は500件以下にしてください。');
  cases.sort((a,b) => a.order - b.order || a.sheetRow - b.sheetRow);
  return cases;
}

function findImage_(filename) {
  const folder = DriveApp.getFolderById(getSettings_().IMAGE_FOLDER_ID);
  const files = folder.getFilesByName(filename);
  if (!files.hasNext()) throw new Error('画像が見つかりません: ' + filename);
  const file = files.next();
  if (files.hasNext()) throw new Error('同名の画像が複数あります: ' + filename);
  if (!['image/jpeg','image/png','image/webp'].includes(file.getMimeType())) throw new Error('未対応の画像形式: ' + filename);
  if (file.getSize() > CASES_IMAGE_LIMIT) throw new Error('画像は800 KiB以下に圧縮してください: ' + filename);
  return file;
}

function buildPublicCases_() {
  const cases = parseCases_(readRows_());
  const versions = {};
  cases.forEach(item => {
    if (item.imageFile) {
      if (!Object.prototype.hasOwnProperty.call(versions,item.imageFile)) {
        versions[item.imageFile] = String(findImage_(item.imageFile).getLastUpdated().getTime());
      }
      item.imageVersion = versions[item.imageFile];
    }
    delete item.order;
    delete item.sheetRow;
  });
  return {ok:true,version:1,cases};
}

/** Run in the Apps Script editor before deploying / after editing. No sheet writes. */
function validateCases() {
  const result = buildPublicCases_();
  console.log('検証OK: 公開実績 ' + result.cases.length + '件。画像・必須項目を確認しました。');
  return result.cases.length;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('LP更新')
    .addItem('入力と画像を検証','validateCasesFromMenu')
    .addItem('検証してビルド','requestBuild')
    .addSeparator()
    .addItem('前回のビルド依頼を確認','showLastBuildRequest')
    .addToUi();
}

function validateCasesFromMenu() {
  const ui = SpreadsheetApp.getUi();
  try {
    ui.alert('検証OK','公開対象 ' + validateCases() + '件。ビルド・公開はまだ行っていません。',ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('入力を確認してください',error.message,ui.ButtonSet.OK);
  }
}

/** Assign `requestBuild` to a Sheet drawing for a visible build button. */
function requestBuild() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('LPをビルドしますか？','現在「公開」の行と画像を保存し、Cloudflareへビルドを依頼します。成功すると本番サイトが更新されます。',ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  let message;
  try {
    const result = requestBuild_();
    message = '公開対象 ' + result.count + '件のビルドを依頼しました。\n保存日時: ' + result.capturedAt + '\n\n公開完了ではありません。Cloudflareのデプロイ結果を確認してください。';
  } catch (error) {
    ui.alert('ビルド依頼を完了できませんでした',error.message,ui.ButtonSet.OK);
    return;
  }
  ui.alert('ビルド依頼を受け付けました',message,ui.ButtonSet.OK);
}

function captureSnapshot_() {
  const result = buildPublicCases_();
  const images = [];
  const seen = new Set();
  let totalBytes = 0;
  result.cases.forEach(item => {
    if (!item.imageFile || seen.has(item.imageFile)) return;
    const file = findImage_(item.imageFile);
    const bytes = file.getBlob().getBytes();
    totalBytes += bytes.length;
    if (totalBytes > CASES_TOTAL_IMAGE_LIMIT) throw new Error('公開画像の合計は10 MiB以下にしてください。');
    images.push({name:item.imageFile,mimeType:file.getMimeType(),base64:Utilities.base64Encode(bytes)});
    seen.add(item.imageFile);
  });
  return {...result,capturedAt:new Date().toISOString(),images};
}

function requestBuild_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('別の担当者がビルド依頼中です。少し待ってください。');
  try {
    const props = PropertiesService.getScriptProperties();
    const settings = getSettings_();
    const hook = settings.CLOUDFLARE_DEPLOY_HOOK || '';
    if (!/^https:\/\/api\.cloudflare\.com\/client\/v4\/pages\/webhooks\/deploy_hooks\/[A-Za-z0-9_-]+$/.test(hook)) {
      throw new Error('CLOUDFLARE_DEPLOY_HOOK にCloudflare PagesのDeploy Hook URLを設定してください。');
    }
    if (!settings.BUILD_API_TOKEN || settings.BUILD_API_TOKEN.length < 32) throw new Error('BUILD_API_TOKEN に32文字以上のランダムな文字列を設定してください。');
    const last = Number(props.getProperty('LAST_BUILD_REQUEST_AT') || 0);
    if (Date.now() - last < 60000) throw new Error('連続ビルドを防ぐため、前回の依頼から1分待ってください。');
    SpreadsheetApp.flush();
    const snapshot = captureSnapshot_();
    const filename = '_omonazo_build_' + snapshot.capturedAt.replace(/[:.]/g,'-') + '.json';
    const file = DriveApp.getFolderById(settings.IMAGE_FOLDER_ID).createFile(filename,JSON.stringify(snapshot),MimeType.PLAIN_TEXT);
    const previous = props.getProperty('BUILD_SNAPSHOT_ID');
    props.setProperty('BUILD_SNAPSHOT_ID',file.getId());
    const restore = () => {
      if (previous) props.setProperty('BUILD_SNAPSHOT_ID',previous);
      else props.deleteProperty('BUILD_SNAPSHOT_ID');
    };
    const uncertain = () => {
      // The request might already be accepted: keep its exact data available to the build.
      recordBuildRequest_(props,snapshot,'応答未確認');
      throw new Error('Cloudflareの応答を確認できません。ビルドが始まっている可能性があるため、デプロイ履歴を確認してください。');
    };
    let response;
    try {
      response = UrlFetchApp.fetch(hook,{method:'post',muteHttpExceptions:true,followRedirects:false});
    } catch (_) {
      uncertain();
    }
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
      restore();
      throw new Error('Cloudflareがビルド依頼を受理しませんでした。Deploy Hook設定を確認してください。');
    }
    let body;
    try { body = JSON.parse(response.getContentText()); } catch (_) { uncertain(); }
    if (body.success === false) {
      restore();
      throw new Error('Cloudflareがビルド依頼を拒否しました。デプロイ設定を確認してください。');
    }
    if (body.success !== true) uncertain();
    recordBuildRequest_(props,snapshot,'受付済み');
    return {count:snapshot.cases.length,capturedAt:snapshot.capturedAt};
  } finally {
    lock.releaseLock();
  }
}

function recordBuildRequest_(props,snapshot,status) {
  props.setProperty('LAST_BUILD_REQUEST_AT',String(Date.now()));
  props.setProperty('LAST_BUILD_CAPTURED_AT',snapshot.capturedAt);
  props.setProperty('LAST_BUILD_CASE_COUNT',String(snapshot.cases.length));
  props.setProperty('LAST_BUILD_REQUEST_STATUS',status);
}

function showLastBuildRequest() {
  const props = PropertiesService.getScriptProperties();
  const time = props.getProperty('LAST_BUILD_CAPTURED_AT');
  SpreadsheetApp.getUi().alert(time ? '前回のビルド依頼\n状態: ' + props.getProperty('LAST_BUILD_REQUEST_STATUS') + '\n保存日時: ' + time + '\n公開対象: ' + props.getProperty('LAST_BUILD_CASE_COUNT') + '件\n\n公開の成否はCloudflareのデプロイ履歴で確認してください。' : 'まだビルドを依頼していません。');
}
