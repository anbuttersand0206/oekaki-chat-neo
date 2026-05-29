import json
import logging
import re

from django.contrib.auth import authenticate, get_user_model, login, logout
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
    """
    return {
        'id': user.id,
        'username': user.username,
        'email': user.email,
        'locale': user.locale,
        'timezone': user.timezone,
    }


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

    if not _MIN_USERNAME_LEN <= len(username) <= _MAX_USERNAME_LEN:
        return JsonResponse(
            {'error': f'ユーザー名は{_MIN_USERNAME_LEN}文字以上{_MAX_USERNAME_LEN}文字以内です'},
            status=400
        )

    if not re.match(r'^[a-zA-Z0-9_\-]+$', username):
        return JsonResponse(
            {'error': 'ユーザー名は英数字・アンダースコア・ハイフンのみ使用できます'},
            status=400
        )

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


@require_GET
def me_view(request: HttpRequest) -> JsonResponse:
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'ログインしてください'}, status=401)
    return JsonResponse({'user': _serialize_user(request.user)})
