import json
import logging
import re

from django.contrib.auth import authenticate, get_user_model, login, logout, update_session_auth_hash
from django.http import HttpRequest, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

logger = logging.getLogger(__name__)

_MIN_PASSWORD_LEN = 8
_MAX_PASSWORD_LEN = 32
_MIN_USERNAME_LEN = 2
_MAX_USERNAME_LEN = 20


def _serialize_user(user) -> dict:
    """User オブジェクトをクライアントへ返すレスポンス形式に変換する。
    フィールドを一か所に集約することで、レスポンス形式の変更が各ビューに波及しない。
    hasPassword: Google SSO のみのユーザーはパスワードが設定されていないため false になる。
    """
    return {
        'id': user.id,
        'username': user.username,
        'email': user.email,
        'locale': user.locale,
        'timezone': user.timezone,
        'hasPassword': user.has_usable_password(),
    }


def _validate_username(username: str) -> str | None:
    """ユーザー名のバリデーション。問題があればエラー文字列を返す。
    登録・プロフィール更新の両方で同じルールを使うため関数に抽出している。
    """
    if not _MIN_USERNAME_LEN <= len(username) <= _MAX_USERNAME_LEN:
        return f'ユーザー名は{_MIN_USERNAME_LEN}文字以上{_MAX_USERNAME_LEN}文字以内です'
    if not re.match(r'^[a-zA-Z0-9_\-]+$', username):
        return 'ユーザー名は英数字・アンダースコア・ハイフンのみ使用できます'
    return None


@csrf_exempt
@require_POST
def register_view(request: HttpRequest) -> JsonResponse:
    """新規ユーザー登録。処理の流れ：入力バリデーション → 重複確認 → ユーザー作成 → 自動ログイン。"""
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'リクエストが不正です'}, status=400)

    username = str(body.get('username', '')).strip()
    # メールアドレスは大文字/小文字を区別しないため小文字に正規化する
    email = str(body.get('email', '')).strip().lower()
    password = str(body.get('password', ''))

    # ── 入力バリデーション ──────────────────────────────────────────────────────
    if not username or not email or not password:
        return JsonResponse({'error': 'すべての項目を入力してください'}, status=400)

    username_error = _validate_username(username)
    if username_error:
        return JsonResponse({'error': username_error}, status=400)

    if not _MIN_PASSWORD_LEN <= len(password) <= _MAX_PASSWORD_LEN:
        return JsonResponse(
            {'error': f'パスワードは{_MIN_PASSWORD_LEN}文字以上{_MAX_PASSWORD_LEN}文字以内です'},
            status=400
        )

    # ── 重複確認（409 Conflict）──────────────────────────────────────────────────
    User = get_user_model()

    if User.objects.filter(email=email).exists():
        return JsonResponse({'error': 'このメールアドレスはすでに登録されています'}, status=409)

    if User.objects.filter(username=username).exists():
        return JsonResponse({'error': 'このユーザー名はすでに使われています'}, status=409)

    # ── ユーザー作成 ───────────────────────────────────────────────────────────
    try:
        user = User.objects.create_user(
            username=username,
            email=email,
            password=password,
        )
    except Exception as e:
        # DB 制約違反など想定外のエラーをまとめてログに記録する
        logger.error(f'[register] ユーザー {email} の作成に失敗しました: {e}', exc_info=True)
        return JsonResponse({'error': 'アカウントの作成に失敗しました'}, status=500)

    # TODO: メール認証を実装する（本番運用前に必須）
    #   現状は登録直後にアカウントを即座に有効化している。
    #   存在しないアドレスや他人のアドレスで登録できてしまうため、
    #   確認メールを送信してリンクを踏んだ後に is_active=True へ切り替えるフローが必要。
    #   対応方針: allauth の send_email_confirmation() を呼び出す、
    #   または ACCOUNT_EMAIL_VERIFICATION='mandatory' に切り替えて
    #   allauth 標準の登録フローに統一する。（README §TODO 参照）

    # 登録直後に自動ログインする（再入力の手間を省く）。
    # allauth のバックエンドを明示しないと login() が AUTHENTICATION_BACKENDS の
    # 設定を解決できずに AttributeError を起こすため、backend を指定している。
    login(request, user, backend='allauth.account.auth_backends.AuthenticationBackend')
    logger.info(f'新規ユーザーが登録されました: {user.email}')
    return JsonResponse({'user': _serialize_user(user)}, status=201)


@csrf_exempt
@require_POST
def login_view(request: HttpRequest) -> JsonResponse:
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'リクエストが不正です'}, status=400)

    # メールアドレスは大文字/小文字を区別しないため小文字に正規化する
    email = str(body.get('email', '')).strip().lower()
    password = str(body.get('password', ''))

    if not email or not password:
        return JsonResponse({'error': 'メールアドレスとパスワードを入力してください'}, status=400)

    user = authenticate(request, email=email, password=password)
    if user is None:
        return JsonResponse({'error': 'メールアドレスまたはパスワードが違います'}, status=401)
    if not user.is_active:
        return JsonResponse({'error': 'このアカウントは無効です'}, status=403)

    login(request, user)
    logger.info(f'ユーザーがログインしました: {user.email}')
    return JsonResponse({'user': _serialize_user(user)})


@csrf_exempt
@require_POST
def logout_view(request: HttpRequest) -> JsonResponse:
    logout(request)
    return JsonResponse({'ok': True})


@csrf_exempt
def me_view(request: HttpRequest) -> JsonResponse:
    """GET: 現在のユーザー情報を返す。PATCH: ユーザー情報を更新する。DELETE: アカウントを削除する。"""
    if request.method == 'GET':
        if not request.user.is_authenticated:
            return JsonResponse({'error': 'ログインしてください'}, status=401)
        return JsonResponse({'user': _serialize_user(request.user)})

    if request.method == 'PATCH':
        return _update_me(request)

    if request.method == 'DELETE':
        return _delete_me(request)

    return JsonResponse({'error': 'Method not allowed'}, status=405)


def _update_me(request: HttpRequest) -> JsonResponse:
    """ユーザー情報の更新処理（me_view の PATCH ハンドラ）。"""
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'ログインしてください'}, status=401)

    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'リクエストが不正です'}, status=400)

    user = request.user
    User = get_user_model()
    has_change = False

    # ── ユーザー名の変更 ────────────────────────────────────────────────────────
    if 'username' in body:
        new_username = str(body['username']).strip()
        error = _validate_username(new_username)
        if error:
            return JsonResponse({'error': error}, status=400)
        if new_username != user.username:
            if User.objects.filter(username=new_username).exclude(pk=user.pk).exists():
                return JsonResponse({'error': 'このユーザー名はすでに使われています'}, status=409)
            user.username = new_username
            has_change = True

    # ── メールアドレスの変更 ────────────────────────────────────────────────────
    if 'email' in body:
        # メールアドレスは大文字/小文字を区別しないため小文字に正規化する
        new_email = str(body['email']).strip().lower()
        if not new_email:
            return JsonResponse({'error': 'メールアドレスを入力してください'}, status=400)
        if new_email != user.email:
            if User.objects.filter(email=new_email).exclude(pk=user.pk).exists():
                return JsonResponse({'error': 'このメールアドレスはすでに登録されています'}, status=409)
            user.email = new_email
            has_change = True

    # ── パスワードの変更 ────────────────────────────────────────────────────────
    if 'newPassword' in body:
        current_password = str(body.get('currentPassword', ''))
        new_password = str(body['newPassword'])
        # 本人確認のため現在のパスワードを要求する
        if not user.check_password(current_password):
            return JsonResponse({'error': '現在のパスワードが違います'}, status=400)
        if not _MIN_PASSWORD_LEN <= len(new_password) <= _MAX_PASSWORD_LEN:
            return JsonResponse(
                {'error': f'新しいパスワードは{_MIN_PASSWORD_LEN}文字以上{_MAX_PASSWORD_LEN}文字以内です'},
                status=400
            )
        user.set_password(new_password)
        has_change = True

    if not has_change:
        return JsonResponse({'user': _serialize_user(user)})

    try:
        user.save()
    except Exception as e:
        logger.error(f'[update_me] ユーザー情報の更新に失敗しました: {e}', exc_info=True)
        return JsonResponse({'error': '更新に失敗しました'}, status=500)

    # パスワード変更後は Django のセッション認証ハッシュが変わり自動ログアウトしてしまう。
    # update_session_auth_hash でセッションを更新してログイン状態を維持する。
    if 'newPassword' in body:
        update_session_auth_hash(request, user)

    logger.info(f'ユーザー情報が更新されました: {user.email}')
    return JsonResponse({'user': _serialize_user(user)})


def _delete_me(request: HttpRequest) -> JsonResponse:
    """アカウント削除処理（me_view の DELETE ハンドラ）。"""
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'ログインしてください'}, status=401)

    try:
        body = json.loads(request.body) if request.body else {}
    except (json.JSONDecodeError, ValueError):
        body = {}

    user = request.user
    email = user.email  # delete() 後に参照できなくなるため先に保持する

    # パスワードを持つユーザーは本人確認のためパスワードを要求する。
    # Google SSO のみのユーザーは has_usable_password() が False になるためスキップする。
    if user.has_usable_password():
        password = str(body.get('password', ''))
        if not password:
            return JsonResponse({'error': 'パスワードを入力してください'}, status=400)
        if not user.check_password(password):
            return JsonResponse({'error': 'パスワードが違います'}, status=400)

    try:
        # セッションを先に無効化してから削除する。
        # 順序を逆にすると logout() がユーザー参照を使うため削除後に例外が出る。
        logout(request)
        user.delete()
    except Exception as e:
        logger.error(f'[delete_me] アカウント削除に失敗しました ({email}): {e}', exc_info=True)
        return JsonResponse({'error': 'アカウントの削除に失敗しました'}, status=500)

    logger.info(f'アカウントが削除されました: {email}')
    return JsonResponse({'ok': True})
