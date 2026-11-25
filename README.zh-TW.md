# aliasflare

SimpleLogin 風格的**電子郵件別名與反向別名**，只需要一個 Cloudflare Worker，搭配 Cloudflare Email Routing 與 Email Sending。

每個網站都用你網域上的獨立地址。aliasflare 把它們的信轉寄到你平常用的信箱（例如 Gmail）；你在那裡回信時，回信會以別名寄出，對方永遠看不到你的真實地址。

[English](README.md)

## 功能

**別名與回信**
- **任意數量的別名網域。** 寄到其中任何地址的信都會送達（Email Routing 的 catch-all），也可以在別名頁面或 App 中預先建立別名。
- **轉寄到你的真實信箱。** 每個別名都轉寄到預設地址，或它自己的地址。
- **透過反向別名回信。** 每位聯絡人都有一個專屬地址，你寄到這個地址的信會以別名寄出。
- **每個別名網域各自使用一個反向別名網域。** `shop@a.com` 的聯絡人寫信到 `reply+…@r.a.com`，`me@b.net` 的聯絡人寫信到 `reply+…@r.b.net`。聯絡人看到的任何內容都不會把你的網域連在一起，反向別名也只能在它自己的網域上使用。
- **主動寫信給新對象。** 為任何地址建立反向別名，從你的真實信箱開始對話。
- **對話串。** 雙向對應 Message-ID，兩邊的對話都保持在同一串。

**SimpleLogin 風格的設定**：寄件者顯示格式、反向別名替換、在反向別名中包含寄件者地址、一鍵退訂（RFC 8058，可停用別名、封鎖寄件者，或代為執行寄件者原本的退訂）。

**隱私與控制**（參考 addy.io、Firefox Relay、DuckDuckGo Email Protection 與 SimpleLogin）
- **移除追蹤器**：移除追蹤像素，並清除連結中的追蹤參數。
- **轉寄 banner**：顯示別名、寄件者、移除的追蹤器數量、一鍵「封鎖寄件者」與「停用別名」；寄件者 DMARC 失敗時會顯示警告，主旨也會加上標記。
- **每個別名的轉寄模式**、**封鎖名單**、**搜尋與批次編輯**、可直接編輯的**備註**。

**App 與瀏覽器擴充功能**
- **SimpleLogin 與 addy.io 用戶端**：在設定中開啟 API、建立 API 金鑰，再讓官方 App 或擴充功能指向你的 Worker。
- **從 SimpleLogin 或 addy.io 匯入**，可用 API 金鑰或匯出的 CSV，也能匯入 SimpleLogin 的聯絡人。

**管理介面**：通行金鑰登入、從管理介面一鍵設定 Cloudflare、35 種語言、深色模式、支援手機。

**選用：Mailflare。** 如果你有架設 [Mailflare](https://github.com/hieunc229/mailflare)，可以改由它接收部分網域並保留每封信的副本；aliasflare 會從它的 webhook 轉寄，並透過 Mailflare 寄出回信，回信因此會出現在它的寄件備份。

## 運作方式

```
                        ┌───────────────── aliasflare Worker ─────────────────┐
 寄件者 ──▶ shop@a.com ─┤ a.com 的 Email Routing catch-all                     │
                        │ 移除追蹤器、加上 banner                              │
                        │ 以 reply+x7k2…@r.a.com 寄出（Email Sending）         ├──▶ you@gmail.com
                        └──────────────────────────────────────────────────────┘
 you@gmail.com ──回信到 reply+x7k2…@r.a.com（Email Routing 規則 reply@r.a.com）
                        │ 檢查：寄件者是你，且 Cloudflare 的 DMARC 結果為 pass
                        ▼
                 Email Sending ──以 shop@a.com 寄出──▶ 寄件者
```

## 需求

- Cloudflare 帳號。**Workers 免費方案**即可：轉寄到你自己信箱使用 Cloudflare Email Sending，任何方案都能寄到已驗證的目的地址。寄給其他人的信（透過反向別名的回信、寄件者的 mailto 退訂）需要 **Workers 付費方案**的 Email Sending，或免費的 **Resend**（每月 3,000 封、每天 100 封）或 **SMTP2GO**（每月 1,000 封）帳號，並在該服務驗證每個別名網域。
- 一個或多個在 Cloudflare 上的**別名網域**。每個都必須是**區域的頂層網域**（`a.com`，不是 `mail.a.com`），因為 Email Routing 只有頂層網域有 catch-all；而且不應該接收其他信件，因為 Email Routing 會接管它的 MX 記錄。

## 安裝

### 1. 部署

```bash
git clone https://github.com/TWME-TW/aliasflare.git
cd aliasflare
npm install
npx wrangler d1 create aliasflare      # 把 database_id 填進 wrangler.jsonc（或不納入 git 的 wrangler.local.jsonc）
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

### 2. 註冊通行金鑰

1. 開啟 `https://aliasflare.<你的子網域>.workers.dev/`，會進入設定頁。
2. 取得**一次性設定碼**：執行 `npx wrangler tail aliasflare`，再到設定頁按「寫入新的設定碼」，設定碼就會出現在終端機（Cloudflare 主控台裡 Worker 的 *Observability* 分頁也看得到日誌）。也可以設定 `SETUP_CODE` secret 改用自己的設定碼。
3. 輸入設定碼並註冊通行金鑰。

### 3. 設定

- **轉寄地址**：你的真實信箱。
- **別名網域**：`a.com, b.net`。它們的反向別名網域分別是 `r.a.com`、`r.b.net`。

### 4. Cloudflare

**自動設定。** 在「連線」頁勾選網域、貼上 API token，按「自動設定」。在「My Profile → API Tokens」為這些區域建立具備以下權限的 token：
- Zone → Zone → Read
- Zone → Zone Settings → Edit
- Zone → DNS → Edit
- Zone → Email Routing Rules → Edit
- **Account** → Email Sending → Edit

前四項是**區域（Zone）**權限：在 *Zone Resources* 選 *Include → Specific zone*，逐一加入每個別名網域的區域，讓 token 不能更動其他網域。Email Sending 是**帳號（Account）**權限：在 *Account Resources* 加入你的帳號。

每個網域都會：啟用 Email Routing 並把 catch-all 指向 Worker；在 `r.<網域>` 啟用 Email Routing、開啟子地址，並建立 `reply@r.<網域>` 規則；兩者都加入 Email Sending。已經把信送往其他地方的 catch-all 不會被更改。重複執行是安全的，token 只用一次、不會儲存。

**手動設定**，每個別名網域 `a.com`：
1. `a.com` 的 Email Routing：啟用，catch-all 設為「傳送到 Worker」→ `aliasflare`。
2. `r.a.com` 的 Email Routing：啟用、開啟**子地址**，新增自訂地址 `reply@r.a.com`，動作為「傳送到 Worker」→ `aliasflare`。
3. Email Sending：加入 `r.a.com` 與 `a.com`。

子網域最多只能有 200 條路由規則，所以用一條 `reply@` 規則加上子地址，涵蓋所有反向別名。

### 5. 選用：SimpleLogin 與 addy.io App

1. 在「設定 → App 與瀏覽器擴充功能」開啟 SimpleLogin 或 addy.io 用戶端支援。
2. 在「API 金鑰」為每個 App 或擴充功能建立一把金鑰。
3. 在 App 或擴充功能選擇自架選項，填入 API 金鑰頁面上顯示的網址和金鑰（SimpleLogin：*API URL*；addy.io：*Instance URL*）。

### 6. 選用：從 SimpleLogin 或 addy.io 匯入

在「匯入」頁列出要匯入的網域，貼上 API 金鑰或上傳匯出的 CSV。SimpleLogin 或 addy.io 自己網域上的別名會繼續在那裡收信，請不要列入；你自己的網域請移到 Cloudflare，並加為別名網域。

### 7. 選用：Mailflare

在「連線 → Mailflare」填入 Mailflare 網址、**個人** API 金鑰（Settings → API keys，勾選 `send` 和 `jmap`，並選取所有要轉寄的信箱），以及指向該頁所示網址的 `message.inbound` webhook 簽章密鑰（以主要管理員身分在 Admin → Webhooks 建立）。由 Mailflare 接收的網域不需要 Email Routing 的 catch-all，但它的反向別名網域仍需要第 4 步的路由規則。

### 8. Workers 方案與寄送服務

在 **連線 → 寄送郵件** 選擇 Workers 方案（預設為免費）與回信寄送方式：Cloudflare Email Sending、Resend 或 SMTP2GO，並填入該服務的 API 金鑰。免費方案每個請求只有 10 毫秒 CPU 與 50 個子請求，因此：

- 大於 512 KB 的信會用 Email Routing 本身的轉寄原封不動送出（不移除追蹤器，回覆這些信也不會經過別名）；
- 大於 512 KB 的回信會被退回並說明原因；
- API 匯入最多 25 個請求，大型帳號請改用 CSV 匯出檔；
- Cloudflare 自動設定每次最多處理 3 個網域。

### 環境變數覆寫

以下變數或 secret 會優先於管理介面中的值：`PUBLIC_URL`、`SIGNING_SECRET`、`SETUP_CODE`、`CLOUDFLARE_API_TOKEN`、`WORKER_NAME`、`MAILFLARE_URL`、`MAILFLARE_API_KEY`、`WEBHOOK_SECRET`、`OUTBOUND_PROVIDER`（`cloudflare`、`resend` 或 `smtp2go`）、`OUTBOUND_API_KEY`、`WORKERS_PLAN`（`free` 或 `paid`）。

## 安全模型

- **管理介面**：通行金鑰（WebAuthn）登入並要求使用者驗證，第一把通行金鑰需要一次性設定碼。登入狀態存在伺服器端，登出或刪除通行金鑰時立即失效，cookie 使用 `__Host-` 前綴；所有變更都會檢查來源，登入有速率限制。
- **反向別名**只接受來自別名轉寄地址、且 Cloudflare 判定 `dmarc=pass` 的信，而且只能在別名自己的反向別名網域上使用。反向別名至少包含 8 個隨機字元。
- **轉寄信中的連結**（退訂、封鎖、停用）經過簽章，只能用一次，90 天後失效；`GET` 只顯示確認頁。回信永遠不會把 banner 或這些連結帶給聯絡人。
- **App API 金鑰**是 238 位元的隨機值，只儲存 SHA-256 雜湊。兩種用戶端 API 預設關閉，並有速率限制。
- **密鑰**：Cloudflare token 永遠不會儲存。選用的 Mailflare API 金鑰與 webhook 密鑰若未設為 secret，會存放在 D1。
- **通行金鑰全部遺失？** 執行 `npx wrangler d1 execute aliasflare --remote --command "DELETE FROM passkeys"`，再用新的設定碼重新註冊。

## 限制

- 使用 Email Routing 時，別名網域必須是頂層網域；子網域仍可由 Mailflare 接收。
- 被略過的信（已封鎖、已停止轉寄）會被丟棄，因為 Email Routing 不保留副本；使用 Mailflare 時，信會留在 Mailflare。
- 透過 App 無法使用 PGP、標籤、使用者名稱和帳號設定。

## 開發

```bash
npm install
npm run check
cp .dev.vars.example .dev.vars && npm run db:migrate:local && npm run dev
```

翻譯位於 `src/locales/`。任何語言缺少鍵值或預留位置時，測試都會失敗。

## 授權

MIT
