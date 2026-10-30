# CronAppwrite

用 GitHub Actions 每小時在 Appwrite 的 `cron` 表新增一筆資料，不需要自己的伺服器。

## 寫入的資料格式

| 欄位 | 型別 | 範例 |
| --- | --- | --- |
| `name`（名稱） | string | `202610301142的資料` |
| `datetime`（日期時間） | string | `2026-10-30 11:42` |
| `remark`（備註） | string | `202610301142的備註` |

內容全部由「執行當下的時間」產生：`202610301142` 就是 `YYYYMMDDHHmm`，所以每小時會得到一筆不同的資料。

> **為什麼 `datetime` 用 string 而不是 datetime 型別？**
> 範例格式 `2026-10-30 11:42` 不是 ISO 8601，Appwrite 的 datetime 欄位會強制存成 `2026-10-30T03:42:00.000+00:00` 之類的格式，前端還得再轉一次。用 string 才能原樣保存你要的格式。若之後要改成 datetime 型別，把腳本裡的 `record.datetime` 改成 `new Date().toISOString()` 即可。

## 專案結構

```
.
├── .github/workflows/hourly-cron.yml   # 每小時執行的排程
├── scripts/insert-cron.mjs             # 產生資料並呼叫 Appwrite API（零依賴）
├── scripts/setup-table.mjs             # 一鍵建立 cron 表與欄位（可重複執行）
├── scripts/lib/appwrite.mjs            # 共用的設定解析與 HTTP 錯誤處理
├── .env.example                        # 本機測試用的環境變數範本
└── package.json
```

## 一、在 Appwrite 建立表

最快的方式是讓程式自己建：設定好下面第二、三步的 API Key 與 Secrets 後，到 Actions → **Run workflow** → mode 選 **setup** 執行一次即可。腳本會建立 `cron` 表、三個欄位，並等到狀態變成 available，重複執行也不會出錯。

想手動建也可以，到 Console → **Databases** → 選擇資料庫 → **Create table**：

1. Table ID 填 `cron`（名稱可叫 `cron`）。
2. 新增三個 **String** 欄位，都設為 **Required**：

   | Key | Size | Required |
   | --- | --- | --- |
   | `name` | 128 | ✅ |
   | `datetime` | 32 | ✅ |
   | `remark` | 255 | ✅ |

3. 等到三個欄位的狀態都變成 **Available**（Appwrite 建立欄位是非同步的，還沒好就寫入會回 400）。
4. Row permissions 不需要開放給一般使用者，腳本是用 API Key 寫入。

> 若你的專案還是舊版結構（Collections / Documents），把表建成 Collection、欄位建成 Attributes 即可，並在 workflow 裡把 `APPWRITE_MODE` 改成 `collection`。

## 二、建立 API Key

Console → **Overview → Integrate with your server → API keys → Create API key**，勾選：

- `rows.read`、`rows.write`（舊版為 `documents.read`、`documents.write`）
- 想用 **setup** 模式自動建表，還要加 `tables.read`、`tables.write`

複製產生的 Key（只會顯示一次）。

## 三、設定 GitHub Secrets

把專案推上 GitHub 後，到 **Settings → Secrets and variables → Actions → New repository secret** 新增：

| Name | 內容 |
| --- | --- |
| `APPWRITE_ENDPOINT` | `https://cloud.appwrite.io/v1`（或你的自架網域，例如 `https://appwrite.example.com/v1`） |
| `APPWRITE_PROJECT_ID` | 專案 ID |
| `APPWRITE_API_KEY` | 上一步的 API Key |
| `APPWRITE_DATABASE_ID` | 資料庫 ID |
| `APPWRITE_TABLE_ID` | `cron` |

> `APPWRITE_DATABASE_ID` 與 `APPWRITE_TABLE_ID` 不是機密，改成 **Variables** 可以讓 Actions 日誌不要把它們遮成 `***`，除錯時比較好讀。

## 四、執行

**自動**：`0 * * * *`，每小時整點（UTC）觸發，推送後即生效。

**手動**：Actions → `cron-hourly-insert` → **Run workflow**，mode 三選一：

| mode | 行為 |
| --- | --- |
| `write`（預設） | 實際寫入一筆資料到 Appwrite |
| `dry_run` | 只印出這次會寫入的內容，不呼叫 API |
| `setup` | 建立 / 補齊 `cron` 表與三個欄位，不寫入資料 |

## 本機測試

```bash
cp .env.example .env      # 填入各項 ID 與 API Key
set -a && source .env && set +a

DRY_RUN=1 node scripts/insert-cron.mjs   # 只印出內容
node scripts/insert-cron.mjs             # 真的寫入一筆
node scripts/setup-table.mjs             # 建立 / 補齊表與欄位
```

輸出範例：

```
[cron] 時區 Asia/Taipei，資料時間 2026-10-30 11:42
[cron] 名稱：202610301142的資料
[cron] 備註：202610301142的備註
[cron] ✓ 已寫入 table <db>/cron，id=67f1c...（HTTP 201）
```

## 注意事項

- **時區**：GitHub 的排程用 UTC，但腳本以 `CRON_TZ`（預設 `Asia/Taipei`）換算時間，所以資料會是台灣時間。要改時區就改 workflow 裡的 `CRON_TZ`。
- **延遲**：GitHub 免費排程在尖峰時可能延後數分鐘到十幾分鐘，資料時間以實際執行時間為準。
- **排程會被停用**：公開 repo 若連續 60 天沒有提交活動，GitHub 會暫停 scheduled workflow，需要進 Actions 重新啟用。
- **重複執行**：同一分鐘內跑兩次會產生兩筆資料（`rowId` 由 Appwrite 隨機產生）。若要避免，可在 workflow 加上 `concurrency`（已預設開啟，僅防同一時間疊跑）。

## 常見錯誤

| 訊息 | 原因 |
| --- | --- |
| `401 / 403` | API Key 無效、專案 ID 錯，或 Key 沒有 `rows.write`（setup 模式另需 `tables.write`）權限 |
| `404 ... table_not_found` | 該資料庫沒有這張表。日誌會列出資料庫內實際存在的表 ID 供對照，或直接跑 `mode = setup` 自動建立 |
| `404 ... collection_not_found` | 同上，但發生在 `auto` 模式的第二段（舊版 collections） |
| `400 ... Invalid document structure` | 欄位 key 拼錯、型別不是 string，或欄位還在 processing |
| `缺少環境變數 ...` | 本機沒 source `.env`，或 GitHub Secrets 名稱打錯 |
