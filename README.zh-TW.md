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

**管理介面**
- **通行金鑰（passkey）登入**，不用密碼，可以註冊多台裝置。
- **連線設定在管理介面填寫**：Mailflare 網址、API key、webhook 密鑰和反向別名網域，都在註冊通行金鑰之後才填寫，部署時不需要任何 secret。
- **多語言**：English、繁體中文、简体中文、日本語。預設跟隨瀏覽器語言，也可以在頁尾切換。
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
3. **連線 Mailflare**：在「連線」頁面：
   - 在 Mailflare 建立有 `jmap` 和 `send` 權限的 API key，貼進來。
   - 在 Mailflare 新增 `message.inbound` webhook，網址填頁面上顯示的 `…/webhook`，再貼上它的簽章密鑰。
   - 填入 Mailflare 網址和反向別名網域。
   - 最後到「設定」頁面填入預設轉寄地址（你的 Gmail）。
4. **在 Cloudflare 設定反向別名網域**
   - Email Routing：catch-all 選「Send to a Worker」，指向 `mailflare-alias`。
   - Email Sending：把網域加進去，並照指示加上 DNS 紀錄（需要 Workers Paid）。

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
