# 多品牌會員、點數與優惠券管理平台

目前可公開註冊會員，以會員、集團管理員或品牌管理員登入。集團管理員可新增品牌和改名，改名後沿用原品牌識別。管理員可在授權品牌以完整會員編號查詢、加點及查看點數流水。會員可查看自己的分品牌餘額和流水。NestJS API 與 Next.js 介面共用本機 HTTP 入口，Prisma 在 PostgreSQL 保存登入、品牌、帳務與加點結果。

## 本機啟動

在專案根目錄執行。初次建置需要網路下載容器映像及套件。

```sh
docker compose up -d --build --wait
```

開啟 [http://membership-rewards.localhost:18441](http://membership-rewards.localhost:18441)。使用這個主機名稱，服務會核對精確的 Host 與寫入 Origin。入口只綁定 `127.0.0.1`，PostgreSQL 僅供 Compose 網路內的服務使用。

在自己的終端取得本機產生的示範密碼。

```sh
docker compose exec app cat /run/membership-app/demo-passwords.json
```

| 帳號 | 角色 | 管理品牌範圍 |
| --- | --- | --- |
| `demo_member` | 會員 | — |
| `group_admin` | 集團管理員 | 全部品牌，含新增品牌 |
| `brand_admin_a` | 品牌管理員 | 預載咖啡品牌 |
| `brand_admin_b` | 品牌管理員 | 預載餐飲品牌 |

1. 選擇「註冊」，輸入帳號、密碼及顯示名稱，再用新帳號登入。畫面會顯示角色與伺服器分配的會員編號。
2. 重新整理頁面確認目前身分。登入工作階段固定 30 分鐘。
3. 在品牌清單查看咖啡和餐飲品牌。登出後以 `group_admin` 登入，在同一區塊新增品牌，或選擇既有品牌旁的「改名」後儲存。若品牌同名，可比對清單上的品牌 ID。名稱去除首尾空白後須為 1 至 80 個字元，且不得含控制字元。
4. 登出後以 `brand_admin_a` 登入，在咖啡品牌選擇「查看點數」，輸入步驟 1 的完整會員編號。輸入正整數點數與原因並加點，確認畫面讀回目前餘額、異動原因、操作者與時間。若結果尚未確認，請選「重試同一次加點」。關閉分頁或重新整理後，可在同一瀏覽器以原帳號查詢相同品牌和會員，找回待確認的操作。重試需要瀏覽器保留網站資料。
5. 登出後用步驟 1 的會員登入，分別查看咖啡和餐飲品牌。咖啡可讀回剛才的加點，從未異動的餐飲品牌顯示零點。預載的 `demo_member` 另有一筆咖啡品牌 100 點的種子流水。

停止服務時，以下指令會保留 PostgreSQL 與密鑰資料卷。再次執行啟動指令會沿用既有資料與示範密碼，包含品牌、授權、點數餘額、流水與加點結果。

```sh
docker compose down
```

備份時請一起保留 `postgres`、`db-secrets` 與 `app-secrets` 資料卷。應用密鑰缺失或與配對紀錄不符時，初始化會停止。請還原原本的 `app-secrets` 卷，再執行啟動指令。既有環境若還沒有配對紀錄，第一次啟動會以當下完整、格式及權限正確的密鑰檔建立紀錄，後續啟動才可比對這組指紋。

## 隔離驗收

測試需要 Docker Compose 2.24.4 或以上。以下指令在獨立的 `membership-rewards-test` 專案套用遷移及初始化，並執行 Jest／Supertest 和真實 PostgreSQL 整合測試。每次只啟動一組測試，共用測試資料庫內的限流與交易測試資料。

```sh
docker compose -p membership-rewards-test -f compose.yaml -f compose.test.yaml run --build --rm backend-checks
```

若要在瀏覽器重跑示範流程，啟動同一測試專案的 `app`，並使用 [http://membership-rewards-test.localhost:18442](http://membership-rewards-test.localhost:18442)。取得測試密碼時也要使用相同的 `-p` 與 `-f` 參數。

```sh
docker compose -p membership-rewards-test -f compose.yaml -f compose.test.yaml up -d --build --wait app
```

以下指令會刪除該測試專案的容器與資料卷，包含測試帳號、工作階段與密鑰。

```sh
docker compose -p membership-rewards-test -f compose.yaml -f compose.test.yaml down --volumes
```

實測環境為 macOS arm64 主機、Linux arm64 容器、Docker Engine 29.8.2、Docker Compose v5.5.0、Node.js 24.22.2、PostgreSQL 17.9、NestJS 11.2.9、Prisma 7.10.1、Next.js 16.4.6 與 React 19.3.1。其他主機平台與 CPU 架構尚待驗證。
