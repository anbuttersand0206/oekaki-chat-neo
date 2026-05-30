import asyncio
import json
import logging
import re
import time
from typing import Any

import bcrypt
from django.http import HttpRequest, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET

from .models import Room, UserRoom
from .sockets import active_users

logger = logging.getLogger(__name__)

_MIN_PASSWORD_LEN = 8
_MAX_PASSWORD_LEN = 32

# インメモリのレート制限（POST /api/rooms：IP ごとに 15 分間で最大 20 回）。
# 部屋作成は無制限だとブルートフォース的な悪用が想定されるため設けた。
# DB ではなくインメモリで管理するのは、低頻度操作なので永続化コストに見合わないため。
_create_attempts: dict[str, list[float]] = {}
# エントリが際限なく増えないよう IP 種別ごとの上限を設ける
_MAX_RATE_ENTRIES = 10_000


def _is_create_rate_limited(ip: str) -> bool:
    now = time.time()
    window_seconds = 15 * 60
    recent_attempts = [t for t in _create_attempts.get(ip, []) if now - t < window_seconds]
    _create_attempts[ip] = recent_attempts
    if len(recent_attempts) >= 20:
        return True
    if len(_create_attempts) > _MAX_RATE_ENTRIES:
        # 枯渇を防ぐため期限切れエントリを都度刈り取る
        stale_ips = [k for k, v in _create_attempts.items() if not v]
        for k in stale_ips:
            del _create_attempts[k]
    _create_attempts[ip].append(now)
    return False


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

    # リバースプロキシ経由の場合は X-Real-IP / X-Forwarded-For を優先する
    ip = (request.META.get('HTTP_X_REAL_IP')
          or request.META.get('HTTP_X_FORWARDED_FOR', '').split(',')[0].strip()
          or request.META.get('REMOTE_ADDR', ''))

    if _is_create_rate_limited(ip):
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
        logger.info(f'New room created: {room_id}')
    except Exception as e:
        logger.error(f'[room_create] Failed to create room {room_id}: {e}', exc_info=True)
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
