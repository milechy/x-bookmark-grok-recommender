# X Bookmark Grok Recommender

X (Twitter) のブックマークを **Grok (xAI)** がセマンティック検索して、ユーザーの要件に最も関連するおすすめをSlackで美しいカード形式で返すボットです。

**特徴**
- `/bookmark <要件>` : ブックマーク全取得 → Grokでランキング → 上位8件をBlock Kitカードで返信（関連度スコア、抜粋、サムネイル、[Xで開く]ボタン）
- `/bookmark-sync` : ブックマーク強制同期（差分更新、最大800件キャッシュ）
- X OAuth2.0 + PKCE完全対応（`bookmark.read` スコープ必須）
- Vercel KV + SQLite ローカルフォールバック
- 日本語完全対応（UI、メッセージ、エラーハンドリング）
- レート制限・エラー処理徹底

## 技術スタック
- **Backend**: @slack/bolt v4 (TypeScript), Node.js 20+
- **X API**: twitter-api-v2 (v2/users/me/bookmarks with pagination & expansions)
- **AI**: xAI Grok API (`https://api.x.ai/v1` via OpenAI SDK, `grok-beta`)
- **Storage**: Vercel KV (prod), better-sqlite3 (local)
- **Deploy**: Vercel Serverless Functions + Vercel KV
- **Others**: Zod (validation), ESLint, Prettier, strict TS

## クイックスタート (Local)

1. **リポジトリをクローン**
   ```bash
   git clone <your-repo>
   cd x-bookmark-grok-recommender
   ```

2. **依存関係インストール**
   ```bash
   npm install
   ```

3. **環境変数設定**
   ```bash
   cp .env.example .env
   # .env を編集（下記参照）
   ```

4. **ローカル起動**
   ```bash
   npm run dev
   ```
   - ngrokなどで公開URLを作成（`https://xxx.ngrok.io/slack/events` をSlackに登録）
   - `REDIRECT_URI` をngrok URL + `/api/oauth/callback` に更新

5. **テスト**
   - Slackで `/bookmark AIエージェント` を実行
   - 初回はDMから「Xでログイン」をクリック

## Vercelデプロイ手順 (推奨)

1. **Vercelプロジェクト作成**
   ```bash
   npm run deploy
   # または Vercel DashboardでGitリポジトリをインポート
   ```

2. **環境変数をVercel Dashboardで設定**
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
   - `X_CLIENT_ID`, `X_CLIENT_SECRET`
   - `GROK_API_KEY`
   - `VERCEL_KV_REST_API_URL`, `VERCEL_KV_REST_API_TOKEN`
   - `REDIRECT_URI=https://your-project-name.vercel.app/api/oauth/callback`

3. **Vercel KVを作成**
   - Vercel Dashboard → Storage → Create KV Database
   - 環境変数が自動リンクされます

4. **デプロイ**
   ```bash
   vercel --prod
   ```

**vercel.json** でServerless Functionsとbuildが設定済みです。

## Slack App 設定手順 (重要)

1. **https://api.slack.com/apps** で新規アプリ作成
2. **OAuth & Permissions**
   - Scopes:
     - `commands`
     - `chat:write`
     - `im:write` (DM用)
     - `users:read`
   - Redirect URLs: あなたのVercel URL (任意)
3. **Slash Commands**
   - `/bookmark` → Request URL: `https://your-app.vercel.app/api/slack` , Description: "要件を指定してブックマークをGrok推薦"
   - `/bookmark-sync` → 同上, Description: "ブックマークを強制同期"
4. **Interactivity & Shortcuts**
   - Enable Interactivity
   - Request URL: `https://your-app.vercel.app/api/slack`
5. **App Home** (任意): Enable
6. **Install to Workspace** → インストール → Bot User OAuth Tokenをコピー

**Event Subscriptions** (必要に応じて): `app_mention`, `message.im` など。

## X (Twitter) APIアプリ作成手順

1. https://developer.x.com/en/portal/dashboard にアクセス
2. **New Project & App** 作成
3. **User authentication settings** を編集:
   - OAuth 2.0 を有効
   - Type: **Native App** または Web App
   - Callback URI / Redirect URL: `https://your-app.vercel.app/api/oauth/callback`
   - Website URL: 任意
4. **Permissions**: Read + Write (bookmark.readのため)
5. **Scopes**: `bookmark.read`, `tweet.read`, `users.read`, `offline.access`
6. **Keys and tokens** から **Client ID**, **Client Secret** を `.env` に設定
7. App設定で **Bookmarks** アクセスを許可

**注意**: XのFree tierではbookmark APIに制限がある場合があります。Basic/Premium推奨。

## 環境変数 (.env.example参照)

必須:
- SLACK_* (4つ)
- X_CLIENT_ID / X_CLIENT_SECRET
- GROK_API_KEY (xAI Consoleから取得: https://console.x.ai/)
- VERCEL_KV_* 

## 動作の詳細

- **キャッシュ**: ブックマークはVercel KVに7日間キャッシュ。`/bookmark-sync`で強制更新。
- **レート制限**: 1回のコマンドで最大800件取得、Grok呼び出しは最小化。
- **Grokプロンプト**: ユーザーの「要件」とブックマークリストを送信し、JSON構造化出力でスコア・理由を取得。
- **UI**: Block Kit使用で美しいカード（スコアバッジ、メディアサムネイル、日付、ユーザー名、Xリンク）。
- **エラー処理**: 全て日本語の親切メッセージ。認証切れ、APIエラー、レート制限を区別。

## FounderOS v2: Obsidian 連携

ブックマークを Obsidian の Markdown ノートとして保存できます。

### 使い方

| 操作 | 結果 |
|---|---|
| `/bookmark-to-obsidian` | キャッシュ済みブックマークの直近 *20* 件を保存 |
| `/bookmark-to-obsidian 50` | 直近 50 件 |
| `/bookmark-to-obsidian all` | キャッシュ全件（最大 100） |
| `/bookmark-to-obsidian help` | ヘルプ表示 |
| 推薦結果末尾の **「📝 Obsidianに保存」** ボタン | その 8 件のみ保存 |

### 保存先（モード自動切替）

環境変数の組み合わせで以下の 3 モードが自動選択されます:

| 優先 | モード | 条件 | 用途 |
|---|---|---|---|
| 1 | `github` | `OBSIDIAN_GITHUB_REPO` + `OBSIDIAN_GITHUB_TOKEN` | **本番推奨**。vault リポジトリへ直接 commit。Obsidian Git plugin で pull |
| 2 | `local` | `OBSIDIAN_VAULT_PATH` 設定 ＆ ローカル実行 | ローカル開発。`fs.writeFile` で直接保存 |
| 3 | `slack-upload` | 上記いずれもなし | フォールバック。`.md` を Slack DM にアップロード（手動で vault へ） |

### ノート形式

`<vault>/00_Inbox/X-Bookmarks/YYYY-MM-DD-<tweet_id>.md`

```markdown
---
source: X
date: 2026-04-28T10:00:00.000Z
tweet_id: "1234567890"
author: "@username (Display Name)"
url: https://x.com/username/status/1234567890
business_potential: 未評価
key_insight: 
tags: []
---

# Display Name (@username)

ブックマーク本文...
```

### セットアップ（GitHub モード）

1. Obsidian vault を GitHub リポジトリで管理（既に行っていれば不要）
2. GitHub の Personal Access Token を発行（必要スコープ: `contents:write`）
   - https://github.com/settings/tokens?type=beta から fine-grained token 推奨
3. Vercel 環境変数を設定:
   ```
   OBSIDIAN_GITHUB_REPO=your-username/obsidian-vault
   OBSIDIAN_GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxx
   OBSIDIAN_GITHUB_BRANCH=main           # 任意
   OBSIDIAN_NOTE_FOLDER=00_Inbox/X-Bookmarks  # 任意
   ```
4. Slack App で Slash Command `/bookmark-to-obsidian` を追加
   - Request URL: `https://your-app.vercel.app/api/slack`
   - 説明: 「ブックマークを Obsidian に保存」
5. デプロイ後、Slack で `/bookmark-to-obsidian help` で動作確認

### 生成モード（次フェーズ）

`ENABLE_GENERATION_MODE=1` で有効化されます（現状はスタブ。`src/services/idea-generator.ts` 参照）。
ブックマークから事業アイデアを Grok で合成し `10_Ideas/Business/` に保存する構想です。

## セキュリティ

- トークンはVercel KVに暗号化保存（TTL付き）
- PKCE + state検証でOAuth2セキュア
- シークレットは決してコードにハードコードせず、env使用
- Input validation (Zod推奨、将来拡張)
- Snyk等で定期スキャン推奨

## 開発

```bash
npm run lint
npm run format
npm run build
```

**TypeScript Strict Mode**, ESLint + Prettier 設定済み。

## 貢献

PR大歓迎！ 特に:
- より高度なembeddingベースsemantic search
- 継続的同期 (cron)
- 多言語対応
- Sentry統合

## ライセンス

MIT

---

**Made with ❤️ for Japanese Slack users | Powered by Grok & Vercel**

質問があれば `/bookmark` コマンドをお試しください！
