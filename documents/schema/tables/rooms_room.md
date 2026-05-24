# rooms_room

描画ルームの基本情報を管理するテーブル。

- **Django モデル**: `rooms.models.Room`
- **作成マイグレーション**: `0001_initial`

---

## カラム定義

| カラム名 | 型 | NOT NULL | デフォルト | 説明 |
|---------|---|---------|-----------|------|
| `id` | `VARCHAR(32)` | ✓ | — | 部屋ID。英数字・`_`・`-` のみ。ユーザー指定（PK） |
| `password_hash` | `TEXT` | ✓ | — | bcrypt ハッシュ（コスト係数 10） |
| `max_users` | `INTEGER` | ✓ | `5` | 同時入室可能な最大人数 |
| `canvas_state` | `TEXT` | — | `NULL` | キャンバスの最新スナップショット（PNG の Data URL）。未保存は NULL |
| `last_emptied_at` | `TIMESTAMPTZ` | — | `NULL` | 最後に空室になった日時。NULL = 現在入室中 |
| `created_at` | `TIMESTAMPTZ` | ✓ | `now()` | 作成日時（Django `auto_now_add`） |

---

## インデックス

| 名前 | 種別 | カラム | 備考 |
|------|------|--------|------|
| `rooms_room_pkey` | PRIMARY KEY | `id` | |
| `rooms_room_id_0437452c_like` | BTREE | `id` varchar_pattern_ops | LIKE 検索用（Django 自動生成） |

---

## 外部キー参照元

| テーブル | カラム | ON DELETE |
|---------|--------|----------|
| `rooms_chatmessage` | `room_id` | CASCADE |

---

## ライフサイクルと `last_emptied_at` の意味

| 値 | 状態 |
|----|------|
| `NULL` | 現在誰かが入室中 |
| `created_at` と同値 | 作成されたが誰も入室していない |
| 任意の日時 | その日時に最後の1人が退出した |

バックグラウンドクリーンアップが `last_emptied_at < now() - 30分` を条件に削除する。

---

## DDL（参考）

```sql
CREATE TABLE rooms_room (
    id               VARCHAR(32)  PRIMARY KEY,
    password_hash    TEXT         NOT NULL,
    max_users        INTEGER      NOT NULL DEFAULT 5,
    canvas_state     TEXT,
    last_emptied_at  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ  NOT NULL
);
```
