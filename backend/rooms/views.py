import asyncio
import json
import logging
import re
from typing import Any

import bcrypt
from django.http import HttpRequest, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET

from common.rate_limit import get_client_ip, is_rate_limited
from .models import Room, UserRoom
from .sockets import active_users

logger = logging.getLogger(__name__)

_MIN_PASSWORD_LEN = 8
_MAX_PASSWORD_LEN = 32

# 部屋作成のレート制限（IP ごとに 15 分間で最大 20 回）。
# 無制限だとブルートフォース的な悪用や部屋名の総当たりが想定されるため設けた。
_room_create_attempts: dict[str, list[float]] = {}
_ROOM_CREATE_WINDOW_SECONDS = 15 * 60
_ROOM_CREATE_MAX_ATTEMPTS = 20


@require_GET
def health(request: HttpRequest) -> JsonResponse:
    return JsonResponse({'ok': True})


@require_GET
async def room_detail(request: HttpRequest, room_id: str) -> JsonResponse:
    try:
        room = await Room.objects.aget(id=room_id)
    except Room.DoesNotExist:
        return JsonResponse({'error': 'Room not found'}, status=404)

    user_count = len(active_users.get(room_id, {}))
    return JsonResponse({
        'id': room.id,
        'userCount': user_count,
        'maxUsers': room.max_users
    })


@csrf_exempt
async def room_create(request: HttpRequest) -> JsonResponse:
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    # request.user は SimpleLazyObject のため async ビュー内では auser() を使う
    user = await request.auser()
    if not user.is_authenticated:
        return JsonResponse({'error': 'ログインしてください'}, status=401)

    ip = get_client_ip(request)
    if is_rate_limited(ip, _room_create_attempts, _ROOM_CREATE_WINDOW_SECONDS, _ROOM_CREATE_MAX_ATTEMPTS):
        return JsonResponse(
            {'error': 'リクエストが多すぎます。しばらくしてから試してください。'}, status=429
        )

    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'リクエストが不正です'}, status=400)

    room_id = str(body.get('roomId', '')).strip()
    password = str(body.get('password', ''))

    if not room_id or not password:
        return JsonResponse({'error': 'roomId と password が必要です'}, status=400)

    if not re.match(r'^[a-zA-Z0-9_\-]{1,32}$', room_id):
        return JsonResponse(
            {'error': '部屋IDは英数字・アンダースコア・ハイフン 32文字以内です'}, status=400
        )

    if len(password) < _MIN_PASSWORD_LEN or len(password) > _MAX_PASSWORD_LEN:
        return JsonResponse(
            {'error': f'パスワードは{_MIN_PASSWORD_LEN}文字以上{_MAX_PASSWORD_LEN}文字以内です'},
            status=400
        )

    if await Room.objects.filter(id=room_id).aexists():
        return JsonResponse({'error': 'その部屋IDはすでに使われています'}, status=409)

    try:
        # bcrypt はブロッキング処理のためスレッドプールに委譲する
        password_hash = await asyncio.to_thread(
            lambda: bcrypt.hashpw(password.encode(), bcrypt.gensalt(10)).decode()
        )
        await Room.objects.acreate(
            id=room_id,
            password_hash=password_hash,
            last_emptied_at=timezone.now()
        )
        logger.info('部屋を作成しました', extra={'room_id': room_id})
    except Exception as e:
        logger.error('[room_create] 部屋の作成に失敗しました', extra={'room_id': room_id}, exc_info=True)
        return JsonResponse({'error': '部屋の作成に失敗しました'}, status=500)

    return JsonResponse({'id': room_id}, status=201)


@require_GET
async def dashboard_rooms(request: HttpRequest) -> JsonResponse:
    """ログイン中ユーザーが過去に参加した部屋の一覧を返す。"""
    # request.user は SimpleLazyObject のため async ビュー内では auser() を使う
    user = await request.auser()
    if not user.is_authenticated:
        return JsonResponse({'error': 'ログインしてください'}, status=401)

    rooms = []
    async for ur in (
        UserRoom.objects
        .filter(user=user)
        .select_related('room')
        .order_by('-joined_at')
    ):
        room = ur.room
        user_count = len(active_users.get(room.id, {}))
        rooms.append({
            'id': room.id,
            'userCount': user_count,
            'maxUsers': room.max_users,
            'joinedAt': ur.joined_at.isoformat(),
        })
    return JsonResponse({'rooms': rooms})
