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

import { resolveConfig, request, ApiError, fail } from './lib/appwrite.mjs';

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

// ---------------------------------------------------------------- 請求組裝

function normalizeMode(raw) {
  const value = String(raw || 'auto').trim().toLowerCase();
  if (['auto', ''].includes(value)) return 'auto';
  if (['table', 'tables', 'row', 'rows', 'tablesdb'].includes(value)) return 'table';
  if (['collection', 'collections', 'document', 'documents'].includes(value)) return 'collection';
  fail(`APPWRITE_MODE 無法辨識：${raw}（可用 auto / table / collection）`);
}

function buildRequest(mode, cfg) {
  if (mode === 'table') {
    return {
      url: `${cfg.endpoint}/tablesdb/${encodeURIComponent(cfg.databaseId)}/tables/${encodeURIComponent(cfg.tableId)}/rows`,
      // TablesDB：新增 row，rowId 交給 Appwrite 產生
      body: (data) => ({ rowId: 'unique()', data }),
      target: `table ${cfg.databaseId}/${cfg.tableId}`,
    };
  }
  return {
    url: `${cfg.endpoint}/databases/${encodeURIComponent(cfg.databaseId)}/collections/${encodeURIComponent(cfg.tableId)}/documents`,
    // 舊版 Databases：新增 document，documentId 交給 Appwrite 產生
    body: (data) => ({ documentId: 'unique()', data }),
    target: `collection ${cfg.databaseId}/${cfg.tableId}`,
  };
}

/** 找不到目標時，列出資料庫內實際存在的表，方便對照 ID */
async function listAvailable(mode, cfg) {
  const url = mode === 'table'
    ? `${cfg.endpoint}/tablesdb/${encodeURIComponent(cfg.databaseId)}/tables?limit=100`
    : `${cfg.endpoint}/databases/${encodeURIComponent(cfg.databaseId)}/collections?limit=100`;

  try {
    const { json } = await request('GET', url, { headers: cfg.headers, timeout: 15000 });
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
      const { status, json } = await request('POST', url, { headers, body });
      return { id: json.$id || json.id || '(unknown)', status };
    } catch (error) {
      // 4xx 屬於設定或權限問題，重試沒意義
      if (error instanceof ApiError && error.status < 500) throw error;
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

  const cfg = resolveConfig();
  const setting = normalizeMode(process.env.APPWRITE_MODE);
  const modes = setting === 'auto' ? ['table', 'collection'] : [setting];

  let lastError;
  for (let i = 0; i < modes.length; i += 1) {
    const mode = modes[i];
    const req = buildRequest(mode, cfg);

    try {
      const result = await postWithRetry(req.url, cfg.headers, req.body(record));
      console.log(`[cron] ✓ 已寫入 ${req.target}，id=${result.id}（HTTP ${result.status}）`);
      return;
    } catch (error) {
      lastError = error;

      if (error instanceof ApiError && error.isNotFound) {
        const available = await listAvailable(mode, cfg);
        if (available) {
          const list = available.length ? available.join('、') : '（空的，一個都沒有）';
          console.warn(`[cron] ${mode} 模式在資料庫 ${cfg.databaseId} 看到的表：${list}`);
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

  fail(
    `${lastError?.message || '未知錯誤'}\n`
    + `[cron] 請到 Appwrite Console 確認資料庫 ${cfg.databaseId} 內有一張 ID 為 ${cfg.tableId} 的表`
    + `（string 欄位 name / datetime / remark），或把 APPWRITE_TABLE_ID 改成上列實際存在的 ID。\n`
    + '[cron] 也可以執行「Run workflow → mode = setup」讓程式自動建立這張表。',
  );
}

main().catch((error) => {
  fail(error?.message || String(error));
});
