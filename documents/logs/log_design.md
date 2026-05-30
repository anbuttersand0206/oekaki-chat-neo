# ログ設計

> 対象: `backend/` 以下の Django バックエンド  
> 実装: `common/logging.py`（`JsonFormatter`）・`oekaki/settings.py`（`LOGGING`）

---

## 目次

1. [設計方針](#1-設計方針)
2. [出力フォーマット](#2-出力フォーマット)
3. [標準フィールド定義](#3-標準フィールド定義)
4. [ロガー設定](#4-ロガー設定)
5. [ログレベル指針](#5-ログレベル指針)
6. [ログ呼び出し規約](#6-ログ呼び出し規約)
7. [イベント一覧](#7-イベント一覧)
8. [制約・注意事項](#8-制約注意事項)

---

## 1. 設計方針

### JSON Lines 形式を採用した理由

テキスト形式の f-string ログには **Log Injection** のリスクがある。  
ユーザー入力に `\n`・`\r` が含まれると、ログエントリの行境界を破壊して偽のログエントリを挿入できる。

```python
# 危険: email に \n が含まれると行が分裂する
logger.info(f'ユーザーが登録されました: {email}')
```

`json.dumps` はすべての制御文字を Unicode エスケープ（`\n` → `\\n`）に変換するため、  
フィールド値にどんな文字列が来てもログの構造を壊せなくなる。

```
# 攻撃入力: "evil@example.com\nINJECTED level=CRITICAL"
# JSON 出力（1行が保たれる）:
{"time":"...","level":"INFO",...,"email":"evil@example.com\nINJECTED level=CRITICAL"}
```

また、JSON Lines は `jq` や各種ログ収集基盤（Fluentd・Loki 等）と親和性が高い。

### ユーザーデータはフィールドに分離する

ユーザー由来の値は**メッセージ文字列に埋め込まず**、`extra=` で独立フィールドとして渡す。

```python
# OK: message は静的文字列、ユーザー由来の値は extra= で分離
logger.info('新規ユーザーが登録されました', extra={'email': user.email})

# NG: ユーザー由来の値が message に混入している
logger.info(f'新規ユーザーが登録されました: {user.email}')
```

---

## 2. 出力フォーマット

**1 イベント = 1 行の JSON**（JSON Lines / NDJSON）。

```json
{"time":"2026-05-30T10:30:00.123+00:00","level":"INFO","logger":"accounts.views","func":"register_view","line":127,"message":"新規ユーザーが登録されました","email":"user@example.com"}
```

整形すると：

```json
{
  "time":    "2026-05-30T10:30:00.123+00:00",
  "level":   "INFO",
  "logger":  "accounts.views",
  "func":    "register_view",
  "line":    127,
  "message": "新規ユーザーが登録されました",
  "email":   "user@example.com"
}
```

例外が発生した場合は `exc_info` フィールドにスタックトレースが追加される：

```json
{
  "time":     "2026-05-30T10:31:00.456+00:00",
  "level":    "ERROR",
  "logger":   "accounts.views",
  "func":     "register_view",
  "line":     112,
  "message":  "[register] ユーザーの作成に失敗しました",
  "email":    "user@example.com",
  "exc_info": "Traceback (most recent call last):\n  ..."
}
```

---

## 3. 標準フィールド定義

すべてのログエントリに含まれる固定フィールド：

| フィールド | 型 | 説明 |
|---|---|---|
| `time` | string | ISO 8601（UTC・ミリ秒精度）例: `2026-05-30T10:30:00.123+00:00` |
| `level` | string | ログレベル: `DEBUG` / `INFO` / `WARNING` / `ERROR` / `CRITICAL` |
| `logger` | string | ロガー名（Python モジュールパス）例: `accounts.views` |
| `func` | string | 呼び出し元の関数名 |
| `line` | number | 呼び出し元の行番号 |
| `message` | string | 静的なメッセージ文字列（ユーザーデータを含まない） |

`extra=` で渡された場合にのみ付加される代表的なフィールド：

| フィールド | 型 | 付加するイベント |
|---|---|---|
| `email` | string | ユーザー登録・ログイン・更新・削除 |
| `room_id` | string | 部屋作成・参加・キャンバス更新・チャット |
| `user_id` | number | ブラシ設定保存 |
| `sid` | string | WebSocket 接続（未認証時） |
| `deleted_empty` | number | 定期クリーンアップ（空室削除件数） |
| `deleted_old` | number | 定期クリーンアップ（老朽部屋削除件数） |
| `exc_info` | string | 例外発生時のスタックトレース（`exc_info=True` 指定時） |

---

## 4. ロガー設定

`oekaki/settings.py` の `LOGGING` で管理。

| ロガー名 | 本番レベル | 開発レベル | 対象ファイル |
|---|---|---|---|
| `accounts` | INFO | DEBUG | `accounts/views.py` |
| `rooms` | INFO | DEBUG | `rooms/views.py`・`rooms/sockets.py` |
| `common` | INFO | DEBUG | `common/*.py` |
| root（その他すべて） | WARNING | WARNING | Django フレームワーク等 |

- `propagate: False` により、各アプリロガーは root ロガーに伝播せず**二重出力しない**。
- root を WARNING に絞ることで、Django 内部の verbose な INFO ログを抑制している。

---

## 5. ログレベル指針

| レベル | 用途 | 例 |
|---|---|---|
| `DEBUG` | 開発時のみ必要な詳細トレース | セッション取得の中間状態など |
| `INFO` | 正常系の業務イベント。運用監視の基本単位 | ログイン成功・部屋作成・アカウント削除 |
| `WARNING` | 処理は続行できるが、通常ではない状態 | 未認証 WebSocket 接続の許可 |
| `ERROR` | 処理が失敗した。調査が必要 | DB 操作失敗・例外発生 |

> `ERROR` には原則 `exc_info=True` を付けてスタックトレースを残す。  
> `WARNING` はアラートの閾値候補。頻発するようなら設計を見直すサイン。

---

## 6. ログ呼び出し規約

### 基本パターン

```python
# INFO: 正常系イベント
logger.info('メッセージ（静的文字列）', extra={'フィールド名': 値})

# WARNING: 異常ではないが注目すべき状態
logger.warning('メッセージ', extra={'フィールド名': 値})

# ERROR: 処理失敗。exc_info=True でスタックトレースを付ける
logger.error('メッセージ', extra={'フィールド名': 値}, exc_info=True)
```

### NG パターン

```python
# NG1: ユーザー由来の値をメッセージ文字列に直接埋め込む（Log Injection リスク）
logger.info(f'ログインしました: {user.email}')

# NG2: 例外を文字列化して message に入れる（exc_info=True で十分）
logger.error(f'処理失敗: {e}', exc_info=True)   # {e} 部分が冗長

# NG3: 例外発生時に exc_info=True を省く（スタックトレースが消える）
logger.error('処理失敗')
```

### extra= キー命名規則

`extra=` に渡すキーは **LogRecord の標準フィールド名と衝突してはならない**。  
以下のキーは使用禁止（上書きが起こりフォーマッターが誤動作する）：

`name` / `msg` / `args` / `levelname` / `levelno` / `pathname` / `filename` /
`module` / `lineno` / `funcName` / `created` / `msecs` / `thread` / `threadName` /
`process` / `processName` / `exc_info` / `exc_text` / `stack_info` / `message` / `asctime`

---

## 7. イベント一覧

### accounts（認証）

| レベル | message | extra フィールド | トリガー |
|---|---|---|---|
| INFO | `新規ユーザーが登録されました` | `email` | 会員登録成功 |
| INFO | `ユーザーがログインしました` | `email` | ログイン成功 |
| INFO | `ユーザー情報が更新されました` | `email` | プロフィール更新成功 |
| INFO | `アカウントが削除されました` | `email` | 退会成功 |
| ERROR | `[register] ユーザーの作成に失敗しました` | `email` + `exc_info` | DB 例外 |
| ERROR | `[update_me] ユーザー情報の更新に失敗しました` | `exc_info` | DB 例外 |
| ERROR | `[delete_me] アカウント削除に失敗しました` | `email` + `exc_info` | DB 例外 |

### rooms（部屋・WebSocket）

| レベル | message | extra フィールド | トリガー |
|---|---|---|---|
| INFO | `部屋を作成しました` | `room_id` | 部屋作成 API 成功 |
| INFO | `[cleanup] 削除完了` | `deleted_empty`・`deleted_old` | 定期クリーンアップ |
| WARNING | `[connect] 未認証の接続を許可しました（操作時に認証チェック）` | `sid` | WebSocket 接続時にセッション無効 |
| ERROR | `[room_create] 部屋の作成に失敗しました` | `room_id` + `exc_info` | DB 例外 |
| ERROR | `[get_session_user] セッション取得中にエラーが発生しました` | `exc_info` | セッション DB 例外 |
| ERROR | `[on_join_room] 部屋への参加中にエラーが発生しました` | `room_id` + `exc_info` | 参加処理中の例外 |
| ERROR | `[canvas_state] DB 更新に失敗しました` | `room_id` + `exc_info` | キャンバス保存失敗 |
| ERROR | `[chat_message] DB 保存に失敗しました` | `room_id` + `exc_info` | チャット保存失敗 |
| ERROR | `[brush_settings] DB 保存に失敗しました` | `user_id` + `exc_info` | ブラシ設定保存失敗 |

---

## 8. 制約・注意事項

### マルチプロセス構成での注意

ログ出力自体は各プロセスが独立して標準出力へ書くため、**ログエントリの欠落は起きない**。  
ただしレート制限カウンターはプロセス内インメモリのため、複数ワーカー構成だと  
制限値が実質的に緩くなる点に注意（ログとは別問題）。

### UTC 出力

`time` フィールドは常に **UTC**（`+00:00`）で出力される。  
JST で読みたい場合は `jq` 等で変換する：

```bash
docker compose logs backend | jq '.time |= (strptime("%Y-%m-%dT%H:%M:%S.%f%z") | strftime("%Y-%m-%dT%H:%M:%S JST"))'
```

### ログの確認方法

```bash
# Docker 環境（JSON Lines をそのまま表示）
docker compose logs backend

# jq で整形表示
docker compose logs backend | jq '.'

# ERROR だけ抽出
docker compose logs backend | jq 'select(.level == "ERROR")'

# 特定のメールアドレスで絞り込み
docker compose logs backend | jq 'select(.email == "user@example.com")'
```
