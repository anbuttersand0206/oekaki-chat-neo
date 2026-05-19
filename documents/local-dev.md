# ローカル開発環境での起動方法（Mac Intel / Colima + Docker CLI）

## 前提条件

Homebrew がインストール済みであること。

---

## 1. Colima・Docker CLI のインストール

```bash
brew install colima docker docker-compose
```

| パッケージ | 役割 |
|-----------|------|
| `colima` | macOS 上で Docker ランタイムを動かす VM |
| `docker` | Docker CLI（コマンド本体） |
| `docker-compose` | Compose v2 CLI プラグイン |

---

## 2. Colima の起動

```bash
colima start
```

Intel Mac（amd64）はデフォルト設定でそのまま動く。  
初回起動は VM イメージのダウンロードがあるため 1〜2 分かかる。

> **確認**  
> ```bash
> docker info   # "Server:" が表示されれば OK
> ```

---

## 3. アプリの起動

```bash
cd oekaki-chat-neo
docker compose up --build
```

ブラウザで **http://localhost:8080** を開く。

> 初回ビルドは npm install（frontend・backend 両方）が走るため数分かかる。  
> 2 回目以降はキャッシュが効いて速い。

---

## 4. 停止

```bash
# Ctrl+C でコンテナを止めた後
docker compose down
```

Colima ごと止める場合（PC をシャットダウンする前など）:

```bash
colima stop
```

---

## 構成

```
http://localhost:8080
    │
    └── nginx（frontend コンテナ）
          ├── /            → Vite ビルド済み静的ファイルを配信
          ├── /api/*       → proxy → backend コンテナ :3001
          └── /socket.io/* → proxy → backend コンテナ :3001 (WebSocket)
```

| コンテナ | 役割 | 公開ポート |
|---------|------|-----------|
| `frontend` | nginx + ビルド済み HTML/JS/CSS | 8080 |
| `backend` | Node.js (Express + Socket.IO) | 3001（内部のみ） |

---

## よくあるトラブル

### `docker` コマンドが "Cannot connect to the Docker daemon" になる

Colima が起動していない。

```bash
colima start
```

### ポート 8080 が使用中

```
Error: Ports are not available: 0.0.0.0:8080
```

`docker-compose.yml` の `ports` 左側を空きポートに変更する。

```yaml
services:
  frontend:
    ports:
      - "3000:80"   # 例: 3000 に変更
```

変更後は **http://localhost:3000** でアクセスする。

### ブラシの Wasm エンジンが読み込まれない

ステータスバーに **「JS Engine」** と表示される場合、TypeScript フォールバックで動作中。描画自体は問題なく使える。  
Wasm を有効にするには Emscripten で手動ビルドし、生成物を `frontend/public/` に配置してから再ビルドする。

```bash
cd brushwasm
make   # em++ (Emscripten) が必要
cd ..
docker compose up --build
```

### ソースを変更後に反映したい

```bash
docker compose up --build
```

### コンテナ・イメージを完全に削除したい

```bash
docker compose down --rmi all --volumes
```

---

## Colima の自動起動設定（任意）

ログイン時に Colima を自動起動したい場合:

```bash
brew services start colima
```

---

## ローカル開発（Colima/Docker なし）

Node.js 20 以上が入っていれば Docker 不要で動かせる。

```bash
# ターミナル 1 — バックエンド
cd oekaki-chat-neo/backend
npm install
node src/server.js
# → http://localhost:3001

# ターミナル 2 — フロントエンド
cd oekaki-chat-neo/frontend
npm install
npm run dev
# → http://localhost:5173
```

Vite の dev proxy が `/api` と `/socket.io` をバックエンドへ自動転送するため CORS 設定は不要。
