# 多品牌會員、點數與優惠券管理平台 v0.1｜專案與測試指南

這個平台模擬同一集團經營咖啡與餐飲品牌。會員使用同一帳號，點數和優惠券按品牌管理。管理員查核券碼並提出核銷，原會員確認後才完成用券。

## 使用的程式語言與技術

| 層面 | 技術 | 用途 |
| --- | --- | --- |
| 前端 | TypeScript 5.9.3、Next.js 16.4.6、React 19.3.1、CSS | 提供會員及管理員操作介面，顯示點數、流水、持有券和核銷請求 |
| 後端 | Node.js 24.22.2、TypeScript 5.9.3、NestJS 11.2.9、Express 5.2.1 | 在同一 HTTP 入口提供網頁與 API，執行角色、品牌範圍及交易驗證 |
| 資料庫 | PostgreSQL 17.9、Prisma 7.10.1、SQL | 透過遷移建立資料結構，以交易、列鎖和資料庫約束維持點數、流水與持有券一致 |
| 登入與授權 | JWT、HttpOnly Cookie、角色及品牌授權 | 保存及撤銷登入工作階段，限制跨品牌與跨會員存取，對登入和核銷嘗試限流 |
| 本機環境 | Docker Compose、Dockerfile、POSIX Shell | 建置服務、載入本機示範密碼、初始化資料，以及經確認後重設 |
| 測試 | Jest 30.5.2、Supertest 7.3.2、Playwright、Chrome | 驗證真實資料庫交易、HTTP 契約、雙角色瀏覽器流程及重啟與重設 |

## 已交付的功能

- **會員與品牌權限。** 使用者可自行註冊為會員。集團管理員可新增與改名品牌，品牌管理員只可操作授權品牌。後台以完整會員編號查詢；會員只可讀取自己的資料。
- **點數與流水。** 各品牌餘額獨立。管理員可人工加點，或在餘額足夠時整筆撤回原加點。系統保留原流水及關聯的反向流水，雙方都能查核。
- **優惠券方案與兌換。** 管理員可在指定期間上架方案或停發。會員以同品牌點數兌換時，扣點、流水與持有券一併提交。停發阻止新兌換，既有券可用至原期限。
- **雙方核銷。** 授權管理員輸入完整券碼提出請求，原會員確認即完成。等待期限取五分鐘與券的剩餘有效時間中較短者。取消、拒絕或到期不消耗券；成功核銷也不再扣點。
- **重試與資料保存。** 使用相同操作識別和內容重試，可取回原結果。正常啟停保留交易及待確認請求的原期限。確認重設會重建示範帳號並產生新密碼，舊登入及交易識別失效。

## 如何測試

以下指令從專案根目錄執行。準備本機 Docker、Docker Compose 2.24.4 以上及桌面 Chrome。首次建置需要下載映像及套件。主機無須另外安裝 Node.js 或 PostgreSQL。

### 手動操作

啟動使用專屬資料卷與連接埠的 `membership-rewards-test`，再從測試容器讀出當次的本機示範密碼。

```sh
docker compose -p membership-rewards-test -f compose.yaml -f compose.test.yaml up -d --build --wait app
docker compose -p membership-rewards-test -f compose.yaml -f compose.test.yaml exec app cat /run/membership-app/demo-passwords.json
```

開啟 [測試網站](http://membership-rewards-test.localhost:18442)。使用一般與無痕視窗分別維持會員和管理員的登入狀態。

1. 註冊一名新會員，登入後記下會員編號。另一個視窗用 `brand_admin_a` 登入，在咖啡品牌以該編號查詢並加 100 點。會員應看到咖啡 100 點、餐飲 0 點。
2. 管理員在咖啡品牌上架需 80 點的方案。以日期時間選擇器選取台北時間（`Asia/Taipei`），開始選現在以前、截止選未來。會員兌換後應取得一張券，流水新增 −80 點，餘額為 20 點。
3. 管理員以完整券碼提出核銷並記下請求 ID。會員確認後，券應顯示「已核銷」。管理員用原 ID 查詢應看到「已完成」，會員餘額仍為 20 點，流水沒有新增核銷扣點。
4. 要核對保存結果，使用同一組 `-p`、`-f` 參數執行 `down`，再執行上方的啟動命令。會員與管理員應能重新查到原券、請求及流水。若要演練清除，使用 `sh docker/reset.sh --test` 並輸入 `membership-rewards-test`。重設完成後重新讀取示範密碼，用 `brand_admin_a` 登入，確認舊券碼和請求 ID 查不到。

品牌改名、方案停發、整筆撤回及重設失敗復原的完整操作見 [README](../README.md)。

### 自動化測試

用隔離的 PostgreSQL 執行 Jest／Supertest。測試涵蓋角色與品牌隔離、兩筆兌換競爭、到期邊界、操作重試、交易回滾及原會員確認。請依序執行各輪測試，避免同時使用同一個測試資料庫。

```sh
docker compose -p membership-rewards-test -f compose.yaml -f compose.test.yaml run --build --rm backend-checks
```

確認測試資料可以清除後，執行下列指令移除測試容器、資料卷與密鑰。

```sh
docker compose -p membership-rewards-test -f compose.yaml -f compose.test.yaml down --volumes
```

## v0.1 實測結果

- 後端 7 套共 **136 項**通過，包含真實 PostgreSQL 上的競爭、回滾及重試測試。
- Chrome 雙角色 **7 組案例**通過。另以隔離專案執行 **11 項 Docker 黑箱案例**，核對資料保留、重設隔離、舊識別失效及失敗後重新初始化。破壞性驗收僅使用測試資料。
- 實測環境為 macOS 27.2.1 arm64、Linux arm64 容器、Docker Engine 29.8.2、Docker Compose 5.5.0、Chrome 156.0.8078.82。其他主機環境及瀏覽器尚待驗證。
