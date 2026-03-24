# jsproxy — Render デプロイ版

元の Cloudflare Worker スクリプト（`worker.js`）を **Node.js + Express** に移植し、
[Render](https://render.com) で動かせるようにしたものです。

---

## ファイル構成

```
.
├── server.js       # メインサーバー（Worker ロジックを Express に変換）
├── package.json
├── render.yaml     # Render 自動デプロイ設定
└── .gitignore
```

---

## ローカル動作確認

```bash
npm install
npm start          # http://localhost:3000 で起動

# 動作確認
curl http://localhost:3000/works
# → it works
```

開発時はホットリロードが便利です：

```bash
npm run dev
```

---

## Render へのデプロイ手順

### 1. GitHub リポジトリを作成してプッシュ

```bash
git init
git add .
git commit -m "init: jsproxy on Render"
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main
```

### 2. Render でサービスを作成

1. [Render Dashboard](https://dashboard.render.com/) を開く
2. **New → Web Service** をクリック
3. GitHub リポジトリを連携・選択
4. 設定はほぼ自動検出されます（`render.yaml` があるため）
5. **Create Web Service** をクリックしてデプロイ完了

デプロイ後、`https://<your-app>.onrender.com/works` にアクセスして
`it works` が返れば成功です。

---

## エンドポイント

| パス | 説明 |
|------|------|
| `/works` | ヘルスチェック。`it works` を返す |
| `/http/<url>` | リバースプロキシ本体。`<url>` は `https://example.com/...` 形式 |
| `/*` | 上流アセットサーバー (`etherdream.github.io/jsproxy`) にフォールバック |

---

## 元コードとの主な差分

| 項目 | Cloudflare Worker | この実装 |
|------|-------------------|----------|
| ランタイム | Service Worker API | Node.js 18+ / Express |
| HTTP クライアント | グローバル `fetch` | `node-fetch` v2 |
| レスポンス返却 | `e.respondWith(Response)` | `res.pipe(expressRes)` |
| HTTPS 強制リダイレクト | あり（CFが担保するため削除可） | Render が TLS 終端するため省略 |
