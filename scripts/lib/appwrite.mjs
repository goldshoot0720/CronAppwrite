/**
 * Appwrite REST API 的共用設定與 HTTP 小工具。
 * 讓 insert-cron.mjs 與 setup-table.mjs 共用同一套錯誤處理與設定解析。
 */

const DEFAULT_TIMEOUT_MS = 20000;

export function fail(message) {
  console.error(`[cron] ✗ ${message}`);
  process.exit(1);
}

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    fail(`缺少環境變數 ${name}（本機測試請參考 .env.example，GitHub 上請設定 Repository secrets）`);
  }
  return value.trim();
}

/** 允許只填 https://cloud.appwrite.io，自動補上 /v1 */
export function endpointBase(raw) {
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

export class ApiError extends Error {
  constructor(message, { status, type } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
  }

  /** 目標（資料庫 / 表 / collection）不存在 */
  get isNotFound() {
    return this.status === 404 || String(this.type || '').endsWith('_not_found');
  }
}

export function parseError(status, text) {
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
    ? '請確認 API Key 有效、專案 ID 正確，且 Key 具備 rows.write / tables.write 權限'
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

export function resolveConfig() {
  const projectId = requiredEnv('APPWRITE_PROJECT_ID');
  const apiKey = requiredEnv('APPWRITE_API_KEY');

  return {
    endpoint: endpointBase(requiredEnv('APPWRITE_ENDPOINT')),
    projectId,
    apiKey,
    databaseId: requiredEnv('APPWRITE_DATABASE_ID'),
    tableId: requiredEnv('APPWRITE_TABLE_ID'),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Appwrite-Project': projectId,
      'X-Appwrite-Key': apiKey,
    },
  };
}

/** 發送請求；非 2xx 一律轉成 ApiError，方便上層判斷狀態碼 */
export async function request(method, url, { headers, body, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();

  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = null;
  }

  if (!res.ok) {
    const parsed = parseError(res.status, text);
    throw new ApiError(parsed.message, { status: res.status, type: parsed.type });
  }

  return { status: res.status, json: json ?? {} };
}
