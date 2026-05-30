# accounts_user

カスタムユーザーモデル（`AbstractUser` 継承）。メールアドレスでログインする。

## カラム定義

| カラム名 | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| `id` | bigint | NO | IDENTITY | サロゲートPK |
| `username` | varchar(150) | NO | — | 表示名（UNIQUE） |
| `email` | varchar(254) | NO | — | ログインID（UNIQUE） |
| `password` | varchar(128) | NO | — | ハッシュ化パスワード（django形式） |
| `google_sub` | varchar(255) | YES | NULL | Google OAuth サブジェクト（UNIQUE, メール登録ユーザーはNULL） |
| `locale` | varchar(10) | NO | `'ja'` | ロケール（現時点では固定） |
| `timezone` | varchar(50) | NO | `'Asia/Tokyo'` | タイムゾーン（現時点では固定） |
| `is_active` | boolean | NO | TRUE | アカウント有効フラグ |
| `is_staff` | boolean | NO | FALSE | Django admin アクセス権 |
| `is_superuser` | boolean | NO | FALSE | 全権限フラグ |
| `date_joined` | timestamptz | NO | now() | 登録日時 |
| `last_login` | timestamptz | YES | NULL | 最終ログイン日時 |
| `first_name` | varchar(150) | NO | `''` | 名（将来用、現状未使用） |
| `last_name` | varchar(150) | NO | `''` | 姓（将来用、現状未使用） |

## 制約

- `UNIQUE(email)` — ログインIDの一意性を保証
- `UNIQUE(username)` — 表示名の重複防止
- `UNIQUE(google_sub)` WHERE NOT NULL — 同一Googleアカウントの二重登録防止

## 拡張余地

プロフィール画像など将来的な属性追加は、`accounts_user_profile` テーブル（1対1）として分離することを推奨（db_design_guide_v2.md §3.1 参照）。

## NULL の意味

- `google_sub = NULL` → メールアドレス＋パスワード認証ユーザー
- `last_login = NULL` → まだログインしていない（date_joined 直後の状態）
