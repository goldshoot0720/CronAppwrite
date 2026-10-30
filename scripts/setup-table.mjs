#!/usr/bin/env node
/**
 * 建立 / 補齊 cron 表（idempotent，可重複執行）。
 *
 * 做三件事：
 *   1. 表不存在就建立（TablesDB）
 *   2. 補上 name / datetime / remark 三個 string 欄位
 *   3. 輪詢到表與欄位都變成 available
 *
 * 環境變數與 insert-cron.mjs 相同，另外需要 tables.write 權限。
 */

import { resolveConfig, request, ApiError, fail } from './lib/appwrite.mjs';

const COLUMNS = [
  { key: 'name', size: 128 },
  { key: 'datetime', size: 32 },
  { key: 'remark', size: 255 },
];

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 30;

function tableUrl(cfg, suffix = '') {
  const base = `${cfg.endpoint}/tablesdb/${encodeURIComponent(cfg.databaseId)}/tables/${encodeURIComponent(cfg.tableId)}`;
  return `${base}${suffix}`;
}

async function ensureTable(cfg) {
  try {
    await request('GET', tableUrl(cfg), { headers: cfg.headers });
    console.log(`[cron] 表 ${cfg.tableId} 已存在，跳過建立`);
    return;
  } catch (error) {
    if (!(error instanceof ApiError) || !error.isNotFound) throw error;
  }

  await request('POST', `${cfg.endpoint}/tablesdb/${encodeURIComponent(cfg.databaseId)}/tables`, {
    headers: cfg.headers,
    body: {
      tableId: cfg.tableId,
      name: cfg.tableId,
      permissions: [],
      rowSecurity: false,
      enabled: true,
    },
  });
  console.log(`[cron] ✓ 已建立表 ${cfg.tableId}`);
}

async function ensureColumns(cfg) {
  for (const column of COLUMNS) {
    try {
      await request('POST', tableUrl(cfg, '/columns/string'), {
        headers: cfg.headers,
        body: { key: column.key, size: column.size, required: true },
      });
      console.log(`[cron] ✓ 已建立欄位 ${column.key}（string ${column.size}, required）`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        console.log(`[cron] 欄位 ${column.key} 已存在，跳過`);
        continue;
      }
      throw error;
    }
  }
}

async function waitUntilReady(cfg) {
  for (let i = 0; i < MAX_POLLS; i += 1) {
    const { json } = await request('GET', tableUrl(cfg), { headers: cfg.headers });
    const status = json.status || 'available';
    const columns = Array.isArray(json.columns) ? json.columns : [];
    const pending = columns.filter((c) => c.status && c.status !== 'available').map((c) => c.key);

    if (status === 'available' && pending.length === 0) {
      console.log('[cron] ✓ 表與欄位都已就緒，可以開始寫入');
      return;
    }

    const detail = pending.length ? `，欄位 ${pending.join('、')} 處理中` : '';
    console.log(`[cron] 等待中…（表狀態 ${status}${detail}）`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  fail('等待表建立完成逾時，請到 Appwrite Console 確認欄位狀態是否為 available');
}

async function main() {
  const cfg = resolveConfig();
  console.log(`[cron] 目標：資料庫 ${cfg.databaseId} / 表 ${cfg.tableId}`);

  await ensureTable(cfg);
  await ensureColumns(cfg);
  await waitUntilReady(cfg);
}

main().catch((error) => {
  fail(error?.message || String(error));
});
