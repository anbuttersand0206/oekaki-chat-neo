import asyncio
import http.cookies
import json as json_mod
import logging
import os
import time
from datetime import timedelta
from typing import Any, Optional

import bcrypt
import socketio
from django.utils import timezone

logger = logging.getLogger(__name__)

CORS_ORIGIN = os.environ.get('CORS_ORIGIN', 'http://localhost:8080')
MAX_BUFFER = 20 * 1024 * 1024  # 20 MB (canvas state)
ROOM_TTL_MINUTES = 30
CLEANUP_INTERVAL_SECONDS = 5 * 60

# ── Validation constants ───────────────────────────────────────────────────────
_MAX_CANVAS_BYTES = 3 * 1024 * 1024
_MAX_POINTS = 5_000
_MAX_BRUSH_JSON = 64_000
_VALID_OP_TYPES = frozenset({'stroke', 'fill', 'clear', 'paste'})
_MAX_RATE_ENTRIES = 10_000

sio = socketio.AsyncServer(
    async_mode='asgi',
    cors_allowed_origins=[o.strip() for o in CORS_ORIGIN.split(',') if o.strip()],
    max_http_buffer_size=MAX_BUFFER,
)

# ── In-memory state ────────────────────────────────────────────────────────────
# active_users: room_id -> {sid: {id, name}}
# id here is str(accounts.User.id)
active_users: dict[str, dict[str, dict[str, str]]] = {}
# join_attempts: ip -> {count, reset_at}
join_attempts: dict[str, dict[str, Any]] = {}
_cleanup_task: Optional[asyncio.Task] = None


async def _cleanup_loop() -> None:
    from .models import Room
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        try:
            cutoff = timezone.now() - timedelta(minutes=ROOM_TTL_MINUTES)
            deleted, _ = await Room.objects.filter(last_emptied_at__lt=cutoff).adelete()
            if deleted:
                logger.info(f'[cleanup] {deleted} stale room(s) deleted')
        except Exception as e:
            logger.error(f'[cleanup] error during cleanup: {e}', exc_info=True)


async def _get_session_user(cookie_str: str):
    """Validate the Django session cookie and return the authenticated User, or None."""
    from django.contrib.sessions.backends.db import SessionStore
    from django.contrib.auth import get_user_model

    try:
        cookies = http.cookies.SimpleCookie()
        cookies.load(cookie_str)
        morsel = cookies.get('sessionid')
        if not morsel:
            return None

        session = SessionStore(session_key=morsel.value)
        auth_user_id = await asyncio.to_thread(lambda: session.get('_auth_user_id'))
        if not auth_user_id:
            return None

        User = get_user_model()
        return await User.objects.aget(id=int(auth_user_id), is_active=True)
    except Exception:
        return None


def _is_rate_limited(ip: str) -> bool:
    now = time.time()
    entry = join_attempts.get(ip)
    if not entry or now > entry['reset_at']:
        if len(join_attempts) > _MAX_RATE_ENTRIES:
            expired = [k for k, v in join_attempts.items() if now > v['reset_at']]
            for k in expired:
                del join_attempts[k]
        join_attempts[ip] = {'count': 1, 'reset_at': now + 60}
        return False
    entry['count'] += 1
    return entry['count'] > 20


def _is_valid_data_url(value: Any) -> bool:
    return (isinstance(value, str)
            and value.startswith('data:image/')
            and len(value) <= _MAX_CANVAS_BYTES)


# ── Handlers ───────────────────────────────────────────────────────────────────

async def on_connect(sid: str, environ: dict, auth: Optional[Any] = None) -> None:
    global _cleanup_task
    if _cleanup_task is None or _cleanup_task.done():
        _cleanup_task = asyncio.create_task(_cleanup_loop())

    headers = {k.decode().lower(): v.decode() for k, v in environ.get('headers', [])}
    ip = (headers.get('x-real-ip')
          or headers.get('x-forwarded-for', '').split(',')[0].strip()
          or (environ.get('client') or [''])[0])

    cookie_str = headers.get('cookie', '')
    user = await _get_session_user(cookie_str)
    if user is None:
        logger.warning(f'[connect] unauthenticated connection rejected: sid={sid}')
        return False  # reject the connection

    await sio.save_session(sid, {
        'ip': ip,
        'auth_user_id': user.id,
        'username': user.username,
    })


async def on_join_room(sid: str, data: Any) -> None:
    from .models import Room, BrushSettings, ChatMessage, UserRoom

    if not isinstance(data, dict):
        await sio.emit('room_error', {'code': 'INVALID', 'message': '入力が不正です'}, to=sid)
        return

    session = await sio.get_session(sid)
    ip = session.get('ip', '')
    auth_user_id = session.get('auth_user_id')
    username = session.get('username')

    if _is_rate_limited(ip):
        await sio.emit('room_error', {
            'code': 'RATE_LIMITED',
            'message': 'リクエストが多すぎます。しばらくしてから試してください。',
        }, to=sid)
        return

    room_id = str(data.get('roomId', '')).strip()
    password = str(data.get('password', ''))

    if not room_id or not password:
        await sio.emit('room_error', {'code': 'INVALID', 'message': '入力が不正です'}, to=sid)
        return

    try:
        room = await Room.objects.aget(id=room_id)
    except Room.DoesNotExist:
        await sio.emit('room_error', {'code': 'NOT_FOUND', 'message': '部屋が見つかりません'}, to=sid)
        return

    users = active_users.get(room_id, {})
    if len(users) >= room.max_users:
        await sio.emit('room_error', {
            'code': 'FULL',
            'message': f'部屋が満員です（最大{room.max_users}人）',
        }, to=sid)
        return

    valid = await asyncio.to_thread(
        bcrypt.checkpw, password.encode(), room.password_hash.encode()
    )
    if not valid:
        await sio.emit('room_error', {'code': 'WRONG_PASSWORD', 'message': 'パスワードが違います'}, to=sid)
        return

    await Room.objects.filter(id=room_id).aupdate(last_emptied_at=None)

    # Record room membership for dashboard
    await UserRoom.objects.aupdate_or_create(
        user_id=auth_user_id,
        room_id=room_id,
        defaults={},
    )

    try:
        brush_settings_record = await BrushSettings.objects.aget(user_id=auth_user_id)
        brush_settings = brush_settings_record.settings
    except BrushSettings.DoesNotExist:
        brush_settings = None

    chat_history = []
    async for msg in ChatMessage.objects.filter(room_id=room_id).order_by('-created_at')[:50]:
        chat_history.append({
            'userId': str(msg.user_id) if msg.user_id else None,
            'username': msg.username,
            'message': msg.message,
            'time': int(msg.created_at.timestamp() * 1000),
        })
    chat_history.reverse()

    user_id = str(auth_user_id)
    if room_id not in active_users:
        active_users[room_id] = {}
    active_users[room_id][sid] = {'id': user_id, 'name': username}

    await sio.save_session(sid, {**session, 'room_id': room_id, 'user_id': user_id})
    await sio.enter_room(sid, room_id)

    await sio.emit('room_joined', {
        'roomId': room_id,
        'userId': user_id,
        'users': [{'id': u['id'], 'name': u['name']} for u in active_users[room_id].values()],
        'canvasState': room.canvas_state,
        'brushSettings': brush_settings,
        'chatHistory': chat_history,
    }, to=sid)
    await sio.emit('user_joined', {'id': user_id, 'name': username}, room=room_id, skip_sid=sid)


async def on_draw_op(sid: str, data: Any) -> None:
    session = await sio.get_session(sid)
    room_id = session.get('room_id')
    if not room_id or not isinstance(data, dict):
        return

    op_type = data.get('type')
    if op_type not in _VALID_OP_TYPES:
        return

    if op_type == 'stroke':
        points = data.get('points')
        if not isinstance(points, list) or len(points) > _MAX_POINTS:
            return

    if op_type == 'paste':
        if not _is_valid_data_url(data.get('dataUrl')):
            return

    await sio.emit('draw_op', {**data, 'userId': session.get('user_id')}, room=room_id, skip_sid=sid)


async def on_canvas_state(sid: str, data: dict) -> None:
    from .models import Room
    session = await sio.get_session(sid)
    room_id = session.get('room_id')
    if not room_id:
        return
    image_data = data.get('imageData')
    if not _is_valid_data_url(image_data):
        return
    try:
        await Room.objects.filter(id=room_id).aupdate(canvas_state=image_data)
    except Exception as e:
        logger.error(f'[canvas_state] DB update failed for room {room_id}: {e}', exc_info=True)


async def on_cursor_move(sid: str, data: dict) -> None:
    session = await sio.get_session(sid)
    room_id = session.get('room_id')
    if not room_id:
        return
    await sio.emit('cursor_move', {
        'userId': session.get('user_id'),
        'username': session.get('username'),
        'x': data.get('x'),
        'y': data.get('y'),
    }, room=room_id, skip_sid=sid)


async def on_chat_message(sid: str, data: Any) -> None:
    from .models import ChatMessage
    if not isinstance(data, dict):
        return
    session = await sio.get_session(sid)
    room_id = session.get('room_id')
    auth_user_id = session.get('auth_user_id')
    username = session.get('username')
    message = str(data.get('message', ''))[:500]
    if not room_id or not message:
        return
    timestamp_ms = int(time.time() * 1000)
    try:
        await ChatMessage.objects.acreate(
            room_id=room_id,
            user_id=auth_user_id,
            username=username,
            message=message,
        )
    except Exception as e:
        logger.error(f'[chat_message] DB insertion failed for room {room_id}: {e}', exc_info=True)
        return
    await sio.emit('chat_message', {
        'userId': str(auth_user_id),
        'username': username,
        'message': message,
        'time': timestamp_ms,
    }, room=room_id)


async def on_brush_settings(sid: str, data: Any) -> None:
    from .models import BrushSettings
    if not isinstance(data, dict):
        return
    session = await sio.get_session(sid)
    auth_user_id = session.get('auth_user_id')
    settings = data.get('settings')
    if not auth_user_id or not isinstance(settings, dict):
        return
    if len(json_mod.dumps(settings)) > _MAX_BRUSH_JSON:
        return
    try:
        await BrushSettings.objects.aupdate_or_create(
            user_id=auth_user_id,
            defaults={'settings': settings},
        )
    except Exception as e:
        logger.error(f'[brush_settings] DB upsert failed for user {auth_user_id}: {e}', exc_info=True)


async def on_disconnect(sid: str, reason: Optional[str] = None) -> None:
    from .models import Room
    session = await sio.get_session(sid)
    room_id = session.get('room_id')
    user_id = session.get('user_id')
    if not room_id:
        return

    users = active_users.get(room_id, {})
    users.pop(sid, None)
    await sio.emit('user_left', {'id': user_id}, room=room_id)

    if not users:
        active_users.pop(room_id, None)
        await Room.objects.filter(id=room_id).aupdate(last_emptied_at=timezone.now())


# ── Register all handlers ──────────────────────────────────────────────────────

def register_handlers() -> None:
    sio.on('connect', on_connect)
    sio.on('disconnect', on_disconnect)
    sio.on('join_room', on_join_room)
    sio.on('draw_op', on_draw_op)
    sio.on('canvas_state', on_canvas_state)
    sio.on('cursor_move', on_cursor_move)
    sio.on('chat_message', on_chat_message)
    sio.on('brush_settings', on_brush_settings)
