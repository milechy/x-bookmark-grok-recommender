# X Bookmark Grok Recommender — システム引き継ぎ資料 (for PM Super Grok)

> 作成: 2026-04-28
> 対象リポジトリ: `milechy/x-bookmark-grok-recommender` (main: `c7a9c80`)
> 本番 URL: `https://x-bookmark-grok-recommender.vercel.app`
> 目的: 既存システムの構成・データフロー・制約を共有し、次の機能追加を安全に行うための単一ソース。

---

## 1. プロダクト一行説明

**Slack 上で `/bookmark <要件>` を叩くと、自分の X (旧 Twitter) のブックマーク（最大800件）から Grok（xAI）が要件に合うものをスコアリング推薦して Block Kit カードで返す Slack ボット。**

- ユーザー固有 OAuth 2.0 (PKCE) で X と連携
- ブックマークと Slack トークンは Vercel KV に保存
- 推薦は Grok 4.20 reasoning（変更可）
- 長文クエリ（5000 文字超）は Slack モーダル → DM
- 推薦履歴は 7 日間記憶し再推薦時に除外（重複防止）

---

## 2. 技術スタック

| 領域 | 採用技術 | 補足 |
|---|---|---|
| ランタイム | Node.js 20+ on Vercel Serverless Functions | Edge は不採用（Deployment Protection 干渉のため） |
| 言語 | TypeScript 5.7 (strict) | `module: NodeNext`, `target: ES2022` |
| Slack | `@slack/web-api` 直叩き | **Bolt は使っていない**（コールドスタート短縮のため自前 HTTP ハンドラ） |
| X API | `twitter-api-v2` v1.18 | OAuth 2.0 PKCE, `bookmark.read` |
| LLM | `openai` SDK + `https://api.x.ai/v1` | Grok の OpenAI 互換 endpoint |
| ストア | Vercel KV (Upstash Redis 互換) | tokens / cache / pkce / debug log / seen / authwarn |
| デプロイ | Vercel + GitHub 連携 | `main` push で本番自動デプロイ |
| ログ閲覧 | 自作 `/api/logs` (KV ring buffer) | ブラウザから 5 秒オートリロード |

主要依存（package.json 抜粋）:
- `@slack/web-api ^7.8.0` / `@slack/bolt ^4.2.1` (※bolt は未使用、削除可)
- `@vercel/functions ^3.4.4` (`waitUntil`)
- `@vercel/kv ^3.0.0`
- `openai ^4.85.1`
- `twitter-api-v2 ^1.18.0`

---

## 3. ディレクトリ・ファイル構造

```
x-bookmark-grok-recommender/
├── api/                          ← Vercel Serverless Functions (HTTP entry)
│   ├── slack.ts                  273 行  Slack 全イベントの入口
│   ├── oauth/callback.ts         100 行  X OAuth 2.0 コールバック
│   ├── logs.ts                   154 行  デバッグログ閲覧 UI
│   └── test.ts                     9 行  ヘルスチェック
│
├── src/
│   ├── slack-process-command.ts 1117 行  ★コア。Slack 全フロー統合
│   ├── services/
│   │   ├── grok.ts               229 行  Grok ランキング呼び出し
│   │   └── x.ts                  189 行  X API + 401 自動リトライ
│   ├── oauth.ts                  220 行  PKCE / token 交換 / refresh
│   ├── storage.ts                 88 行  KV ラッパ（tokens / cache）
│   ├── debug-log.ts              129 行  KV ring buffer ロガー
│   ├── types.ts                   76 行  ドメイン型
│   ├── app.ts / commands.ts / index.ts  (旧 Bolt 構成。現在未使用、削除候補)
│
├── docs/
│   └── system-overview.md        本ドキュメント
│
├── vercel.json                   maxDuration / memory 設定
├── tsconfig.json
├── package.json
├── .env.example                  環境変数テンプレート
└── README.md
```

**現在の有効コードパス:**
- 入口: `api/slack.ts` → `src/slack-process-command.ts`
- OAuth: `api/oauth/callback.ts` → `src/oauth.ts`
- 補助: `src/services/*`, `src/storage.ts`, `src/debug-log.ts`

**未使用 / 削除候補:**
- `src/app.ts`, `src/commands.ts`, `src/index.ts` — 旧 Bolt 実装の残骸。`@slack/bolt` 依存も併せて削除可能。

---

## 4. 主要モジュールの責務

### 4.1 `api/slack.ts` — Slack 入口（HTTP）

**責務: 署名検証して即 200 ACK し、重い処理は `waitUntil` で動的 import に丸投げ。**

ポイント:
- `bodyParser: false` で raw body をストリームから自前読み出し（署名検証はバイト一致が必要）
- `Content-Type` で 3 種を分岐:
  - `application/x-www-form-urlencoded` + `payload=` → **Interactivity** (modal submit / block_actions)
  - `application/x-www-form-urlencoded` + `command=` → **Slash Command** (`/bookmark`, `/bookmark-sync`)
  - `application/json` → **Events API** (`url_verification`, `event_callback`)
- Slack の自動リトライ (`x-slack-retry-num` 付き) は無視して即 200
- **重要な順序:** `waitUntil(...)` 登録 → `res.end()`。逆だと Vercel が関数を凍結して BG 処理が走らない（過去に大ハマり）

### 4.2 `src/slack-process-command.ts` — コアロジック (1117 行)

ここに全機能が集約されている。主な構成:

| 区画 | 関数 | 役割 |
|---|---|---|
| Responder 抽象 | `makeSlashResponder` / `makeDMResponder` | Slack 応答チャネル（`response_url` vs `chat.postMessage`）を統一 IF |
| モーダル | `openBookmarkModal` | 要件入力モーダル（`force_sync` / `reset_seen` チェック付き） |
| モーダル | `openRefineModal` | 「もっとこういう視点で」絞り込みモーダル |
| メイン | `runBookmarkFlow` | X取得 → seen 除外 → Grok → Block Kit 表示 → seen 追加 |
| エンタイトル | `processSlackCommand` | スラッシュコマンドの振り分け |
| エンタイトル | `processSlackInteractivity` | view_submission / block_actions 振り分け |
| エンタイトル | `processSlackEvent` | Events API（現在 `app_home_opened` のみ） |
| App Home | `publishHomeView` | 認証 / キャッシュ / 設定 / 使い方を表示 |
| 補助 | `maybeWarnStaleAuth` | 30日超過で 1 日 1 回の DM 予告 |
| 補助 | `sendAuthErrorIfNeeded` | 401 検知 → 再ログインボタン |
| 補助 | seen 系 | `getSeenIds` / `addSeenIds` / `clearSeenIds`（既表示除外） |

> **注意:** 1 ファイルに集中しすぎている自覚あり。アップデートのタイミングで責務分割（`flows/`, `views/`, `responders/` など）を検討するのが望ましい。

### 4.3 `src/services/x.ts`

- `XService(accessToken, slackUserId)` でインスタンス化
- `withAuthRetry()`: 401 を検知したら `refreshXAccessToken` で 1 回だけ更新して再試行。失敗したら「再ログインしてください」エラーを投げる
- `getAllBookmarks(forceSync, slackUserId)`: 24h 以内のキャッシュを優先、なければ最大 8 ページ × 100 件 = 800 件まで取得
- 各リクエスト間で 1 秒 sleep（rate limit 対策）

### 4.4 `src/services/grok.ts`

- xAI Grok API を OpenAI SDK 経由で叩く（`baseURL: https://api.x.ai/v1`）
- 入力は最新 50 件に制限（プロンプト肥大化防止）
- システムプロンプトで「スコアばらつき / 多様性 / クエリの具体的引用」を要求
- 出力 JSON を寛容にパース（`recommendations` 配列 / 直接配列 / 任意キーの配列を許容）
- `bookmark_id` または本文プレフィックスで XBookmark を解決
- 失敗時は明示的に Error throw（過去に「無言で失敗」したのを修正済み）
- `GROK_ALLOW_KEYWORD_FALLBACK=1` でキーワード類似フォールバック ON

### 4.5 `src/oauth.ts`

- `createAuthUrl()`: PKCE verifier を `pkce:<state>` キーで KV に 10 分保存
- `handleOAuthCallback()`: code → token、`tokens:<slackUserId>` に 30 日保存
- `refreshXAccessToken()`: refresh_token で更新。失敗時 null 返却
- スコープ: `bookmark.read tweet.read users.read offline.access tweet.write offline.access`
  - ※ `offline.access` が 2 回入っているのは要修正候補（重複）

### 4.6 `src/storage.ts` / `src/debug-log.ts`

- `storage`: `tokens:` (TTL 30d) / `cache:` (TTL 7d) のラッパ
- `DebugLogger`: `debug:log` リスト（最大 500 件 LPUSH/LTRIM）+ `debug:req:<id>` 単位（TTL 1h）
- `/api/logs` がブラウザ表示

---

## 5. 主要データフロー

### 5.1 短文 `/bookmark <要件>`

```
Slack
 └─POST /api/slack (form)─→ api/slack.ts
                              ├─ 署名検証
                              ├─ 200 ACK ←(3秒以内)
                              └─ waitUntil
                                  └─ processSlackCommand
                                      └─ runBookmarkFlow
                                          ├─ storage.getUserTokens (KV)
                                          ├─ XService.initialize (refresh付)
                                          ├─ XService.getAllBookmarks (KV cache or X API)
                                          ├─ seen 除外 (KV SET)
                                          ├─ GrokService.rankBookmarks
                                          ├─ Block Kit を response_url へ送信
                                          └─ seen 追加 (KV SET)
```

### 5.2 長文（モーダル）

```
/bookmark        ─→ views.open (bookmark_modal)
ユーザー Submit  ─→ POST /api/slack (form, payload=...) — view_submission
                    └─ processSlackInteractivity
                        └─ runBookmarkFlow → 結果は DM (chat.postMessage)
```

### 5.3 絞り込み再検索

```
推薦結果末尾の「🔁 もっとこういう視点で絞り込む」ボタン
    └─ block_actions
        └─ openRefineModal (元クエリは private_metadata)
            └─ refine_modal Submit
                └─ 「元クエリ ＋ 追加視点」を結合
                    └─ runBookmarkFlow → DM
```

### 5.4 App Home

```
ユーザーが Slack のアプリ画面で「ホーム」タブを開く
    └─ Slack が event_callback (app_home_opened) を JSON POST /api/slack
        └─ processSlackEvent → publishHomeView (views.publish)
```

### 5.5 X OAuth

```
未連携で /bookmark
    └─ createAuthUrl → 認証 URL ボタン提示
        └─ ユーザーが押下 → x.com/i/oauth2/authorize
            └─ コールバック /api/oauth/callback
                └─ handleOAuthCallback (token 交換)
                    ├─ storage.saveUserTokens (KV)
                    └─ chat.postMessage で「認証完了 DM」
```

---

## 6. KV キー一覧（データ設計）

| キー | 値 | TTL | 用途 |
|---|---|---|---|
| `tokens:<slackUserId>` | `UserTokens` JSON | 30日 | X アクセス/リフレッシュトークン |
| `cache:<slackUserId>` | `BookmarkCache` JSON | 7日 | ブックマークキャッシュ |
| `seen:<slackUserId>` | Set<bookmark_id> | 7日 | 既表示除外 |
| `pkce:<state>` | code_verifier | 10分 | PKCE フロー中間 |
| `authwarn:<slackUserId>` | 1 | 24時間 | 30日超過予告 DM の重複抑止 |
| `debug:log` | List<LogEntry JSON> | なし（ring buffer 500） | グローバルログ |
| `debug:req:<reqId>` | List<LogEntry JSON> | 1時間 | リクエスト単位ログ |

---

## 7. 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✅ | xoxb-... |
| `SLACK_SIGNING_SECRET` | ✅ | 署名検証用 |
| `X_CLIENT_ID` | ✅ | X OAuth |
| `X_CLIENT_SECRET` | ✅ | 〃（confidential client） |
| `GROK_API_KEY` | ✅ | xAI |
| `GROK_MODEL` |  | デフォルト `grok-4.20-reasoning` |
| `GROK_ALLOW_KEYWORD_FALLBACK` |  | `1` で失敗時フォールバック |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | ✅ | Vercel KV |
| `LOGS_ACCESS_TOKEN` | ✅ | `/api/logs` 認証用 |
| `REDIRECT_URI` |  | デフォルト `https://x-bookmark-grok-recommender.vercel.app/api/oauth/callback` |

---

## 8. Slack App 必要設定

- **OAuth Scopes (Bot):** `chat:write`, `chat:write.public`, `commands`, `im:write`, `users:read`
- **Slash Commands:** `/bookmark`, `/bookmark-sync` → Request URL `/api/slack`
- **Interactivity:** Request URL `/api/slack`
- **Event Subscriptions:** Request URL `/api/slack`、Bot Events: `app_home_opened`
- **App Home:** Home Tab 有効、Messages Tab 有効

---

## 9. デプロイ・ビルド

- `main` への push で Vercel が自動デプロイ
- `vercel.json`:
  - `api/slack.ts`: `maxDuration: 60s`, `memory: 1024MB`
  - `api/oauth/callback.ts`: `maxDuration: 15s`
- ビルドコマンドは実質 noop。Vercel が `api/*.ts` を自動コンパイル

---

## 10. これまでに解決済みの落とし穴（再発防止メモ）

| 問題 | 原因 | 対策 |
|---|---|---|
| Slack `operation_timeout` | 3 秒 ACK 厳守 | 署名検証→即 200、重処理は `waitUntil` |
| `waitUntil` で BG が走らない | Vercel Node ランタイムの仕様 | `waitUntil` を `res.end()` **より前**に登録 |
| 401 でいきなりエラー | アクセストークン 2h 失効 | `refreshXAccessToken` を `withAuthRetry` で1回試行 |
| 5000文字超で無視 | Slash Command 4000 文字制限 | モーダル + DM フロー |
| Grok 失敗が無音 | 例外を握り潰していた | 明示的に throw + Slack へ通知 |
| 同じブックマークばかり | 履歴を持たず毎回フル候補 | KV `seen:<user>` (7日) で除外 |
| URL アンファール混入 | Slack の自動展開 | DM の postMessage に `unfurl_links/media: false` |
| コールドスタートで時間切れ | top-level import が重い | 重依存はすべて `waitUntil` 内で動的 import |

---

## 11. 既知の制約・注意点

1. **X API の Bookmarks エンドポイントは Basic プラン ($200/月) 以上が必要。** Free だと 402 が返る。
2. **Grok クレジット残高切れ** で 402/403 が返るので、PM 監視が必要。
3. **Slack action `value` は 2000 文字まで。** 「絞り込み」ボタンに乗せる元クエリは 1900 でカット済み。
4. **Slack `private_metadata` は 3000 文字まで。** refine モーダルでは 2800 でカット済み。
5. **Slack ブロック数は 50 が上限**（現在 45 で運用、`maxBlocks=50` に変更済み）。
6. **`bookmark_id` 解決の脆さ:** Grok が ID を返さず本文片だけ返すケースがあり、本文プレフィックスマッチでフォールバック。完全に hallucination するとマッチ漏れが発生する。
7. **`offline.access` が SCOPES 文字列に重複している**（実害なし、要清掃）。
8. **`src/app.ts`, `src/commands.ts`, `src/index.ts` は旧 Bolt 実装の残骸**（依存も削除可）。

---

## 12. 機能チートシート

| Slack 操作 | 結果 |
|---|---|
| `/bookmark <要件>` | チャンネル ephemeral で進捗 → 推薦結果 |
| `/bookmark` または `/bookmark ?` | モーダル起動（force_sync / reset_seen 選択可） |
| モーダル送信 | DM に進捗 → 推薦結果 |
| 推薦結果末尾「🔁 もっとこういう視点で絞り込む」 | refine モーダル → DM |
| `/bookmark-sync` | フル再同期 + seen クリア |
| App Home タブ表示 | 認証 / キャッシュ / 設定 / 使い方 |
| ブラウザで `/api/logs?token=…` | 直近 500 件のログを表示 |

---

## 13. 想定される次の改善余地（PM 提案ネタ）

短期:
- Bolt 残骸の削除と `slack-process-command.ts` のファイル分割
- `offline.access` 重複修正
- Block Kit の薄いコンポーネント化（recommendation card など）
- スコープ別エラーメッセージのテンプレ化

中期:
- 推薦結果に「👍 / 👎」フィードバックボタン → Grok プロンプトに反映 / seen 強制
- 多言語対応（現状は日本語固定文言だらけ）
- 複数ワークスペース対応（OAuth Distribution）
- ブックマーク以外の対象（自分のいいね、リスト）追加

長期:
- 推薦履歴を時系列で蓄積し、ユーザープロファイル学習
- Webhook 駆動の定期推薦（毎週月曜 DM など）
- Embedding ベースの事前フィルタ（プロンプト 50 件制限を超える対応）

---

以上です。コードに直接当たる場合の最初の入口は `api/slack.ts` → `src/slack-process-command.ts` で十分追えます。ログは `https://x-bookmark-grok-recommender.vercel.app/api/logs?token=$LOGS_ACCESS_TOKEN`。
