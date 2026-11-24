# mailflare-alias

為 [Mailflare](https://github.com/hieunc229/mailflare) 加上 SimpleLogin 式的**反向別名（reverse alias）**，只用一個 Cloudflare Worker。

信照樣收進 Mailflare，mailflare-alias 再轉一份到你習慣用的信箱（例如 Gmail）。你在 Gmail 直接回覆，對方看到的是別名，看不到你的真實地址。

[English](README.md)

## 功能

**別名與回信**
- **轉寄到真實信箱**：可設定預設轉寄地址，每個別名也能各自指定。
- **透過反向別名回信**：每個聯絡人都有專屬的反向別名。寄到這個地址的信會以別名身分寄出，並存進 Mailflare 的寄件備份。
- **主動寫信給新對象**：可以替任何地址建立反向別名，從真實信箱發起對話。
- **對話串接**：雙向對應 Message-ID，兩邊的信都會串在同一個對話裡。

**SimpleLogin 式設定**
- **寄件者顯示格式（Sender Address Format）**：有 `John Wick - john at wick.com`、`John Wick - john(a)wick.com`、`John Wick`、`john at wick.com`，或不顯示名稱。
- **反向別名替換（Reverse Alias Replacement）**：回信內文中的反向別名換回對方的真實地址，你的真實地址則換成別名。
- **反向別名包含寄件者地址**：新產生的反向別名可以是 `john_at_wick_com_x7k2p9@…` 這種看得出是誰的格式。
- **一鍵退訂**（RFC 8058）：在信箱按「取消訂閱」時，依設定執行以下其中一種：
  - 停用別名
  - 封鎖這個寄件者
  - 代你執行對方原本的退訂機制

**隱私與控制**（參考 addy.io、Firefox Relay、DuckDuckGo Email Protection 和 SimpleLogin）
- **移除追蹤器**：移除追蹤像素，並刪除連結中的追蹤參數（`utm_*`、`fbclid`、`mc_eid` 等）。
- **轉寄資訊橫幅**：在每封轉寄信上方顯示：
  - 寄到哪個別名、寄件者是誰
  - 移除了幾個追蹤器
  - 一鍵「封鎖寄件者」和「停用別名」連結
  - 寄件者未通過 DMARC、可能是偽造時的警告
- **每個別名各自的轉寄模式**：全部轉寄、封鎖促銷信（郵件清單）、不轉寄。
- **封鎖名單**：可封鎖地址，或整個網域（含子網域），對所有別名生效。
- **別名備註**：替每個別名寫下用途。

**App 與瀏覽器擴充功能**
- **支援 SimpleLogin 與 addy.io 用戶端**：在「設定」開啟任一種 API 並建立 API 金鑰後，就能用官方的 SimpleLogin 或 addy.io App、瀏覽器擴充功能連到你的 Worker，列出、搜尋、建立、釘選、啟用、停用和刪除別名，修改備註與轉寄地址，並管理反向別名（SimpleLogin 的聯絡人）。
- **從 SimpleLogin 或 addy.io 匯入**：用 API 金鑰或別名匯出檔（CSV）匯入，備註、顯示名稱、啟用狀態、釘選和轉寄地址都會一起帶過來。只匯入你選擇的網域，重複匯入也沒關係。
- **從 App 建立的新別名**放在你設定的「別名網域」上，格式可選單字（`maple.otter42`）、隨機字元、UUID，或自訂前綴。

**管理介面**
- **通行金鑰（passkey）登入**，不用密碼，可以註冊多台裝置。
- **在管理介面設定 Cloudflare**：填入 API token 後按一下，就會為反向別名網域開啟 Email Routing、Email Sending 並建立路由規則。
- **連線設定在管理介面填寫**：Mailflare 網址、API key、webhook 密鑰和反向別名網域，都在註冊通行金鑰之後才填寫，部署時不需要任何 secret。
- **35 種語言**：與 Mailflare 相同，再加上繁體中文。阿拉伯文、波斯文和烏爾都文會由右至左排版。預設跟隨瀏覽器語言，也可以在選單切換。
- **外觀與 Mailflare 一致**，支援淺色與深色模式。
- **支援手機、平板和桌機**：在小螢幕上，表格會變成卡片。

## 安裝

1. **部署**
   ```bash
   git clone https://github.com/TWME-TW/mailflare-alias.git
   cd mailflare-alias
   npm install
   npx wrangler d1 create mailflare-alias      # 把 database_id 填進 wrangler.jsonc（或不會被 commit 的 wrangler.local.jsonc）
   npx wrangler d1 migrations apply DB --remote
   npx wrangler deploy
   ```
2. **註冊通行金鑰**
   - 打開 Worker 網址，會進入初始設定頁。
   - 到 Worker 日誌找一次性設定碼，有效時間 60 分鐘。可以到 Cloudflare 後台 → Workers & Pages → mailflare-alias → Observability → Logs 查看，或執行 `npx wrangler tail mailflare-alias` 後重新整理頁面。
   - 輸入設定碼並註冊通行金鑰。
3. **連線 Mailflare**

   Mailflare 的 API key 分兩種，mailflare-alias 要用的是**一般使用者的 API key**：

   | | 一般使用者 API key | 管理員 API key |
   |---|---|---|
   | 在 Mailflare 的位置 | **設定 → API keys** | 管理 → API keys |
   | 權限 | `send`、`read`、`jmap`、`calendar:*` | `domains`、`accounts`、`mailboxes`、`storage` |
   | 範圍 | 只限你勾選的信箱（最多 30 個） | 整個 Mailflare |
   | mailflare-alias 是否使用 | **是**，需要 `send` + `jmap` | 否 |

   管理員 API key 不能讀信也不能寄信，所以用在這裡沒有作用。

   在「連線」頁面：
   - **API key**：到 Mailflare 的 **設定 → API keys** 建立一把 key。
     - 勾選 `send` 和 `jmap` 權限。
     - 勾選**所有要轉寄別名的信箱**。沒有勾到的信箱，信不會被轉寄。之後新增信箱時，要再建立一把包含它的新 key。

     建好後把 key 貼進來。
   - **Webhook**：以**主要管理員**身分登入 Mailflare（只有主要管理員能管理 webhook），到 **管理 → Webhooks** 新增：
     - 事件選 `message.inbound`；
     - 網址填頁面上顯示的 `…/webhook`。

     再把它的簽章密鑰貼進來。webhook 只對建立它的帳號所擁有的信箱生效，也就是主要管理員的信箱。
   - 填入 Mailflare 網址和反向別名網域。
   - 最後到「設定」頁面填入預設轉寄地址（你的 Gmail）。
4. **在 Cloudflare 設定反向別名網域**

   反向別名的格式是 `reply+ra_x7k2…@r.example.com`。Cloudflare 的 catch-all 只能用在根網域，子網域最多只能有 200 條規則，所以改用「子地址（subaddressing）」：只要一條 `reply@r.example.com` 的規則，就能涵蓋所有反向別名。

   - **自動設定**：到「連線 → Cloudflare」貼上 API token，按「自動設定」。token 在 Cloudflare 的「My Profile → API Tokens」建立，對該 zone 需要以下權限：
     - Zone → Zone → Read
     - Zone → Zone Settings → Edit
     - Zone → Email Routing Rules → Edit
     - Zone → Email Sending → Edit

     頁面會列出每個步驟的結果，重複執行也沒關係。
   - **手動設定**：
     - Email Routing：為 `r.example.com` 啟用，在 Email Routing 設定中開啟子地址，再新增自訂地址 `reply@r.example.com`，動作選「Send to a Worker」→ `mailflare-alias`。
     - Email Sending：加入 `r.example.com`（需要 Workers Paid）。
5. **（選用）SimpleLogin 與 addy.io App**
   1. 到「設定 → 應用程式與瀏覽器擴充功能」，開啟 SimpleLogin、addy.io 或兩者的支援。
   2. 填入**別名網域**，也就是 App 可以建立新別名的網域。在 Mailflare 為這些網域設定 **catch-all**，Mailflare 才會接收原本不存在的地址的信。
   3. 到「API 金鑰」頁面，為每個 App 或擴充功能各建立一把金鑰。
   4. 在 App 或擴充功能選擇自架伺服器，填入 API 金鑰頁面顯示的伺服器網址（也就是 Worker 的網址）和金鑰：
      - **SimpleLogin**：*API URL*。
      - **addy.io**：*Instance URL*。

   金鑰可以管理別名，但不能變更設定。資料庫只存金鑰的雜湊值。
6. **（選用）從 SimpleLogin 或 addy.io 匯入**

   到「匯入」頁面，列出要搬移的網域，再貼上 SimpleLogin 或 addy.io 的 API 金鑰，或上傳它們的別名匯出檔（CSV）。金鑰只用這一次，不會儲存。

   只有你自己網域上的別名需要匯入。SimpleLogin 或 addy.io 網域上的別名仍然由它們收信，不用列入。要收到寄給匯入別名的信，必須先把該網域的 MX 移到 Cloudflare，加入 Mailflare 並設定 catch-all。

   匯入不會帶過聯絡人（反向別名）、PGP 金鑰，每個別名也只會帶過第一個轉寄地址。

## 安全性

- **管理介面**：用通行金鑰（WebAuthn）登入，並要求使用者驗證。第一把通行金鑰必須用日誌裡的一次性設定碼才能註冊。cookie 設為 HttpOnly、Secure、SameSite=Strict，每次變更都會檢查 Origin，登入與初始設定都有頻率限制。
- **webhook**：必須帶有 Mailflare 的 HMAC 簽章，重複送達也只會轉寄一次。
- **反向別名**：只接受同時符合以下兩個條件的信：
  - 寄件者（header `From`）是這個別名的轉寄地址；
  - Cloudflare 判定該網域的 DMARC 為 pass。
- **轉寄信中的連結**（退訂、封鎖、停用）：都有簽章且會過期。用 GET 打開只會顯示確認頁，所以連結掃描器不會誤觸。
- **忘記或遺失所有通行金鑰**：執行 `npx wrangler d1 execute mailflare-alias --remote --command "DELETE FROM passkeys"` 後，用新的設定碼重新註冊。

## 授權

MIT
