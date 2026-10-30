#!/usr/bin/env node
/**
 * 掃描專案內所有資料庫，找出名稱或 ID 含 cron 的表。
 * 用途：不確定 APPWRITE_DATABASE_ID / APPWRITE_TABLE_ID 該填什麼時，先跑這個。
 *
 * 只需要 APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY，
 * 以及 databases.read、tables.read 權限。
 */

import {
  endpointBase, requiredEnv, request, ApiError, fail,
} from './lib/appwrite.mjs';

const PATTERN = /cron/i;

function label(item) {
  return item.name && item.name !== item.$id ? `${item.$id}（${item.name}）` : item.$id;
}

function buildConfig() {
  const projectId = requiredEnv('APPWRITE_PROJECT_ID');
  return {
    endpoint: endpointBase(requiredEnv('APPWRITE_ENDPOINT')),
    projectId,
    headers: {
      Accept: 'application/json',
      'X-Appwrite-Project': projectId,
      'X-Appwrite-Key': requiredEnv('APPWRITE_API_KEY'),
    },
  };
}

async function main() {
  const cfg = buildConfig();
  console.log(`[cron] 專案 ${cfg.projectId}，端點 ${cfg.endpoint}`);

  let databases = [];
  try {
    const { json } = await request('GET', `${cfg.endpoint}/databases?limit=100`, { headers: cfg.headers });
    databases = Array.isArray(json.databases) ? json.databases : [];
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      fail(`API Key 沒有讀取資料庫清單的權限（${error.status}）。請在 Key 加上 databases.read / tables.read。`);
    }
    throw error;
  }

  if (!databases.length) {
    fail('這個專案沒有任何資料庫');
  }

  console.log(`[cron] 共 ${databases.length} 個資料庫，開始尋找符合 ${PATTERN} 的表…\n`);

  const matches = [];

  for (const database of databases) {
    let tables = [];
    try {
      const { json } = await request(
        'GET',
        `${cfg.endpoint}/tablesdb/${encodeURIComponent(database.$id)}/tables?limit=100`,
        { headers: cfg.headers },
      );
      tables = Array.isArray(json.tables) ? json.tables : [];
    } catch (error) {
      const reason = error instanceof ApiError ? `HTTP ${error.status}` : error.message;
      console.log(`· ${label(database)}：讀不到表（${reason}）`);
      continue;
    }

    const hit = tables.filter((table) => PATTERN.test(table.$id) || PATTERN.test(table.name || ''));
    console.log(`· ${label(database)}：${tables.length} 張表${hit.length ? `，命中 ${hit.length} 張` : ''}`);

    for (const table of hit) {
      matches.push({ database, table });
    }
  }

  if (!matches.length) {
    fail(`所有資料庫都找不到名稱含 cron 的表。請確認表是否已建立，或改用 mode = setup 建立。`);
  }

  console.log('\n[cron] 找到以下符合的表，請把對應 ID 填入 secrets（或手動觸發時的輸入框）：');
  for (const { database, table } of matches) {
    console.log(`  APPWRITE_DATABASE_ID = ${database.$id}`);
    console.log(`  APPWRITE_TABLE_ID    = ${table.$id}    ← ${label(table)}`);
    console.log(`  （資料庫名稱：${database.name}）\n`);
  }
}

main().catch((error) => {
  fail(error?.message || String(error));
});
