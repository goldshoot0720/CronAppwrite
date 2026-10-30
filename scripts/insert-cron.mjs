#!/usr/bin/env node
/**
 * 在 Appwrite 的 cron 表新增一筆資料（供 GitHub Actions 每小時呼叫）。
 *
 * 以 2026-10-30 11:42 執行為例，寫入的內容為：
 *   名稱      202610301142的資料
 *   日期時間   2026-10-30 11:42
 *   備註      202610301142的備註
 *
 * 環境變數：
 *   APPWRITE_ENDPOINT    例：https://cloud.appwrite.io/v1
 *   APPWRITE_PROJECT_ID  Appwrite 專案 ID
 *   APPWRITE_API_KEY     具備 rows.write（舊版為 documents.write）權限的 API Key
 *   APPWRITE_DATABASE_ID 資料庫 ID
 *   APPWRITE_TABLE_ID    表 ID（舊版為 collection ID）
 *   APPWRITE_MODE        table（預設，TablesDB 的 tables/rows）| collection（舊版 collections/documents）
 *   CRON_TZ              時區，預設 Asia/Taipei
 *   DRY_RUN              設為 1 時只印出內容、不呼叫 API
 */

const TZ = (process.env.CRON_TZ || 'Asia/Taipei').trim();
const DRY_RUN = ['1', 'true', 'yes'].includes(String(process.env.DRY_RUN || '').toLowerCase());
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------- 時間與資料

/**
 * 取得指定時區的「現在」，避免 GitHub Actions 的 UTC 環境寫進錯誤的時間。
 * 使用 hourCycle: 'h23'，午夜才會是 00 而不是 24。
 */
function nowParts(timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
  } catch {
    fail(`CRON_TZ 不是合法的時區：${timeZone}`);
  }

  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
  };
}

/** 依範例格式組出 name / datetime / remark 三個欄位 */
function buildRecord(now) {
  const stamp = `${now.year}${now.month}${now.day}${now.hour}${now.minute}`;
  return {
    name: `${stamp}的資料`,
    datetime: `${now.year}-${now.month}-${now.day} ${now.hour}:${now.minute}`,
    remark: `${stamp}的備註`,
  };
}

// ------------------------------------------------------------------ 設定解析

function fail(message) {
  console.error(`[cron] ✗ ${message}`);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    fail(`缺少環境變數 ${name}（本機測試請參考 .env.example，GitHub 上請設定 Repository secrets）`);
  }
  return value.trim();
}

function normalizeMode(raw) {
  const value = String(raw || 'table').trim().toLowerCase();
  if (['table', 'tables', 'row', 'rows', 'tablesdb'].includes(value)) return 'table';
  if (['collection', 'collections', 'document', 'documents'].includes(value)) return 'collection';
  fail(`APPWRITE_MODE 無法辨識：${raw}（可用 table 或 collection）`);
}

/** 允許只填 https://cloud.appwrite.io，自動補上 /v1 */
function endpointBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`APPWRITE_ENDPOINT 不是合法網址：${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    fail(`APPWRITE_ENDPOINT 必須是 http(s) 網址：${raw}`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  const basePath = /\/v\d+$/.test(path) ? path : `${path}/v1`;
  return `${url.origin}${basePath}`;
}

function buildRequest({ endpoint, databaseId, tableId }) {
  const mode = normalizeMode(process.env.APPWRITE_MODE);
  if (mode === 'table') {
    return {
      url: `${endpoint}/tablesdb/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(tableId)}/rows`,
      // TablesDB：新增 row，rowId 交給 Appwrite 產生
      body: (data) => ({ rowId: 'unique()', data }),
      target: `table ${databaseId}/${tableId}`,
    };
  }
  return {
    url: `${endpoint}/databases/${encodeURIComponent(databaseId)}/collections/${encodeURIComponent(tableId)}/documents`,
    // 舊版 Databases：新增 document，documentId 交給 Appwrite 產生
    body: (data) => ({ documentId: 'unique()', data }),
    target: `collection ${databaseId}/${tableId}`,
  };
}

// -------------------------------------------------------------------- 寫入

async function createRecord({ url, body, headers }) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();

      if (res.ok) {
        let payload = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          /* 回應不是 JSON 也無妨，狀態碼成功即可 */
        }
        return { id: payload.$id || payload.id || '(unknown)', status: res.status };
      }

      const detail = describeError(res.status, text);
      // 4xx 屬於設定或權限問題，重試沒意義
      if (res.status < 500) fail(detail);
      lastError = new Error(detail);
    } catch (error) {
      if (error?.message?.startsWith('[cron]')) throw error;
      lastError = error;
    }

    if (attempt < MAX_ATTEMPTS) {
      const waitMs = attempt * 2000;
      console.warn(`[cron] 第 ${attempt} 次失敗：${lastError.message}；${waitMs / 1000} 秒後重試`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  fail(`重試 ${MAX_ATTEMPTS} 次仍失敗：${lastError?.message || '未知錯誤'}`);
}

function describeError(status, text) {
  let message = text;
  try {
    const json = JSON.parse(text);
    if (json.message) message = `${json.message}${json.type ? `（${json.type}）` : ''}`;
  } catch {
    /* 保留原始文字 */
  }
  const hint = status === 401 || status === 403
    ? '：請確認 API Key 有效、專案 ID 正確，且 Key 具備 rows.write 權限'
    : status === 404
      ? '：請確認資料庫 ID、表 ID 是否正確，以及 Appwrite 版本是否支援 TablesDB'
      : status === 400
        ? '：多半是欄位名稱或型別與表定義不符'
        : '';
  return `Appwrite 回應 ${status} ${message}${hint}`;
}

// -------------------------------------------------------------------- 主流程

async function main() {
  const now = nowParts(TZ);
  const record = buildRecord(now);

  console.log(`[cron] 時區 ${TZ}，資料時間 ${record.datetime}`);
  console.log(`[cron] 名稱：${record.name}`);
  console.log(`[cron] 備註：${record.remark}`);

  if (DRY_RUN) {
    console.log('[cron] DRY_RUN 已啟用，略過寫入');
    return;
  }

  const endpoint = endpointBase(requiredEnv('APPWRITE_ENDPOINT'));
  const projectId = requiredEnv('APPWRITE_PROJECT_ID');
  const apiKey = requiredEnv('APPWRITE_API_KEY');
  const databaseId = requiredEnv('APPWRITE_DATABASE_ID');
  const tableId = requiredEnv('APPWRITE_TABLE_ID');

  const request = buildRequest({ endpoint, databaseId, tableId });
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Appwrite-Project': projectId,
    'X-Appwrite-Key': apiKey,
  };

  const result = await createRecord({
    url: request.url,
    headers,
    body: request.body(record),
  });

  console.log(`[cron] ✓ 已寫入 ${request.target}，id=${result.id}（HTTP ${result.status}）`);
}

main().catch((error) => {
  fail(error?.message || String(error));
});
