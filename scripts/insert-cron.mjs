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
 *   APPWRITE_MODE        auto（預設）| table | collection
 *                        auto = 先試 TablesDB 的 tables/rows，找不到就退回舊版 collections/documents
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
  const value = String(raw || 'auto').trim().toLowerCase();
  if (['auto', ''].includes(value)) return 'auto';
  if (['table', 'tables', 'row', 'rows', 'tablesdb'].includes(value)) return 'table';
  if (['collection', 'collections', 'document', 'documents'].includes(value)) return 'collection';
  fail(`APPWRITE_MODE 無法辨識：${raw}（可用 auto / table / collection）`);
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

function buildRequest(mode, { endpoint, databaseId, tableId }) {
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

class ApiError extends Error {
  constructor(message, { status, type } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
  }

  /** 目標（資料庫 / 表 / collection）不存在，換另一種模式或提示使用者建立 */
  get isNotFound() {
    return this.status === 404 || String(this.type || '').endsWith('_not_found');
  }
}

function parseError(status, text) {
  let message = text;
  let type;
  try {
    const json = JSON.parse(text);
    if (json.message) message = json.message;
    type = json.type;
  } catch {
    /* 保留原始文字 */
  }

  const hint = status === 401 || status === 403
    ? '請確認 API Key 有效、專案 ID 正確，且 Key 具備 rows.write 權限'
    : status === 404
      ? '請確認資料庫 ID、表 ID 是否正確，以及該表是否已經建立'
      : status === 400
        ? '多半是欄位名稱或型別與表定義不符'
        : '';

  return {
    type,
    message: `Appwrite 回應 ${status} ${message}${type ? `（${type}）` : ''}${hint ? `：${hint}` : ''}`,
  };
}

/** 找不到目標時，列出資料庫內實際存在的表 / collection，方便對照 ID */
async function listAvailable(mode, ctx, headers) {
  const url = mode === 'table'
    ? `${ctx.endpoint}/tablesdb/${encodeURIComponent(ctx.databaseId)}/tables?limit=100`
    : `${ctx.endpoint}/databases/${encodeURIComponent(ctx.databaseId)}/collections?limit=100`;

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    const items = mode === 'table' ? json.tables : json.collections;
    if (!Array.isArray(items)) return null;
    return items.map((item) => (item.name && item.name !== item.$id ? `${item.$id}（${item.name}）` : item.$id));
  } catch {
    return null;
  }
}

async function postWithRetry(url, headers, body) {
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

      const parsed = parseError(res.status, text);
      const error = new ApiError(parsed.message, { status: res.status, type: parsed.type });
      // 4xx 屬於設定或權限問題，重試沒意義
      if (res.status < 500) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      lastError = error;
    }

    if (attempt < MAX_ATTEMPTS) {
      const waitMs = attempt * 2000;
      console.warn(`[cron] 第 ${attempt} 次失敗：${lastError.message}；${waitMs / 1000} 秒後重試`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw lastError;
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

  const ctx = {
    endpoint: endpointBase(requiredEnv('APPWRITE_ENDPOINT')),
    databaseId: requiredEnv('APPWRITE_DATABASE_ID'),
    tableId: requiredEnv('APPWRITE_TABLE_ID'),
  };
  const projectId = requiredEnv('APPWRITE_PROJECT_ID');
  const apiKey = requiredEnv('APPWRITE_API_KEY');

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Appwrite-Project': projectId,
    'X-Appwrite-Key': apiKey,
  };

  const setting = normalizeMode(process.env.APPWRITE_MODE);
  const modes = setting === 'auto' ? ['table', 'collection'] : [setting];

  let lastError;
  for (let i = 0; i < modes.length; i += 1) {
    const mode = modes[i];
    const request = buildRequest(mode, ctx);
    try {
      const result = await postWithRetry(request.url, headers, request.body(record));
      console.log(`[cron] ✓ 已寫入 ${request.target}，id=${result.id}（HTTP ${result.status}）`);
      return;
    } catch (error) {
      lastError = error;

      if (error instanceof ApiError && error.isNotFound) {
        const available = await listAvailable(mode, ctx, headers);
        if (available) {
          console.warn(`[cron] ${mode} 模式在資料庫 ${ctx.databaseId} 看到的表：${available.length ? available.join('、') : '（空的，一個都沒有）'}`);
        }
      }

      const next = modes[i + 1];
      if (next && error instanceof ApiError && error.isNotFound) {
        console.warn(`[cron] ${mode} 模式找不到目標，改用 ${next} 模式重試`);
        continue;
      }
      break;
    }
  }

  const detail = lastError?.message || '未知錯誤';
  fail(
    `${detail}\n`
    + `[cron] 請到 Appwrite Console 確認資料庫 ${ctx.databaseId} 內有一張 ID 為 ${ctx.tableId} 的表`
    + `（string 欄位 name / datetime / remark），或把 APPWRITE_TABLE_ID 改成上列實際存在的 ID。`,
  );
}

main().catch((error) => {
  fail(error?.message || String(error));
});
