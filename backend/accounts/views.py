import json
import logging

from django.contrib.auth import authenticate, get_user_model, login, logout
from django.http import HttpRequest, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

logger = logging.getLogger(__name__)


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
    logger.info(f'User {user.email} logged in')
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
