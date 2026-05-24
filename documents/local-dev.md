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

## 3. 環境変数の設定

```bash
cd oekaki-chat-neo
cp .env.example .env
```

`.env` を開いて以下の 2 項目を設定する。

| 変数 | 用途 |
|------|------|
| `POSTGRES_PASSWORD` | PostgreSQL のパスワード（任意の文字列） |
| `DJANGO_SECRET_KEY` | Django の署名キー（任意の長い文字列） |

---

## 4. アプリの起動

```bash
docker compose up --build -d
```

ブラウザで **http://localhost:8080** を開く。

> 初回ビルドは pip install（backend）と npm install（frontend）が走るため数分かかる。  
> 2 回目以降はキャッシュが効いて速い。

---

## 5. 停止

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
| `backend` | Django + python-socketio (uvicorn) | 3001（内部のみ） |
| `postgres` | PostgreSQL 16 | 5432（内部のみ） |

PostgreSQL のデータは Docker named volume `pgdata` に保存される。  
`docker compose down` してもデータは消えない。データごと削除したい場合は `--volumes` を付ける。

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

### コンテナ・イメージを完全に削除したい（DB データも消える）

```bash
docker compose down --rmi all --volumes
```

### backend コンテナが "waiting for PostgreSQL" のまま止まる

PostgreSQL の起動より backend が先に立ち上がろうとした場合。  
`docker compose up` を再実行するか、少し待ってから確認する。  
ヘルスチェックにより通常は自動でリトライされる。

---

## Colima の自動起動設定（任意）

ログイン時に Colima を自動起動したい場合:

```bash
brew services start colima
```

---

## ローカル開発（Colima/Docker なし）

Python 3.12 以上と PostgreSQL が必要。

```bash
# PostgreSQL に oekaki データベースと oekaki ユーザーを作成しておく

# ターミナル 1 — バックエンド
cd oekaki-chat-neo/backend
pip install -r requirements.txt

export PGHOST=localhost
export PGDATABASE=oekaki
export PGUSER=oekaki
export PGPASSWORD=your_password
export DJANGO_SECRET_KEY=dev-secret-key

python manage.py migrate
uvicorn oekaki.asgi:application --host 0.0.0.0 --port 3001
# → http://localhost:3001

# ターミナル 2 — フロントエンド
cd oekaki-chat-neo/frontend
npm install
npm run dev
# → http://localhost:5173
```

Vite の dev proxy が `/api` と `/socket.io` をバックエンドへ自動転送するため CORS 設定は不要。
