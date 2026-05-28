# rooms_userroom

ユーザーと部屋の参加履歴を記録する中間テーブル。ダッシュボードの「参加した部屋一覧」に使用する。

## カラム定義

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| `id` | bigint | NO | IDENTITY | サロゲートPK |
| `user_id` | bigint | NO | — | FK → `accounts_user.id` |
| `room_id` | varchar(32) | NO | — | FK → `rooms_room.id` |
| `joined_at` | timestamptz | NO | now() | 最初に参加した日時 |

## 制約

- `UNIQUE(user_id, room_id)` — 1ユーザー×1部屋は1レコード（再入室は joined_at を更新しない）
- `ON DELETE CASCADE` (user) — ユーザー削除時に参加履歴も削除
- `ON DELETE CASCADE` (room) — 部屋削除時（TTL期限切れ含む）に参加履歴も削除

## ライフサイクル

```
Socket join_room 成功
  → UPSERT rooms_userroom (user_id, room_id)
     （既存レコードがあれば joined_at は変わらない）

rooms_room 削除（バックグラウンドクリーンアップ）
  → CASCADE で rooms_userroom も削除
  → ダッシュボードの一覧から自然に消える
```
