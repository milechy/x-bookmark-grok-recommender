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
