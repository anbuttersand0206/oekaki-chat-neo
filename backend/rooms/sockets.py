import asyncio
import json as json_mod
import logging
import os
import time
import uuid
from datetime import timedelta
from typing import Any, Optional

import bcrypt
import socketio
from django.utils import timezone

logger = logging.getLogger(__name__)

CORS_ORIGIN = os.environ.get('CORS_ORIGIN', 'http://localhost:8080')
MAX_BUFFER = 20 * 1024 * 1024  # 20 MB (canvas state)
ROOM_TTL_MINUTES = 30
CLEANUP_INTERVAL_SECONDS = 5 * 60  # Check DB every 5 minutes

# ── Validation constants ───────────────────────────────────────────────────────
_MAX_CANVAS_BYTES = 3 * 1024 * 1024        # 3 MB — WebP at 0.85q for 1600×1200 fits well under this
_MAX_POINTS = 5_000                         # max dab points per stroke op
_MAX_BRUSH_JSON = 64_000                    # 64 KB for serialised brush settings
_VALID_OP_TYPES = frozenset({'stroke', 'fill', 'clear', 'paste'})
_MAX_RATE_ENTRIES = 10_000

sio = socketio.AsyncServer(
    async_mode='asgi',
    cors_allowed_origins=[o.strip() for o in CORS_ORIGIN.split(',') if o.strip()],
    max_http_buffer_size=MAX_BUFFER,
)

# ── In-memory state ────────────────────────────────────────────────────────────
# active_users: room_id -> {sid: {id, name}}
active_users: dict[str, dict[str, dict[str, str]]] = {}
# join_attempts: ip -> {count, reset_at}
join_attempts: dict[str, dict[str, Any]] = {}
# Background cleanup task (runs once)
_cleanup_task: Optional[asyncio.Task] = None


async def _cleanup_loop() -> None:
    """Periodically deletes rooms that have been empty for too long."""
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


def _is_rate_limited(ip: str) -> bool:
    """Checks if an IP address is exceeding the join room rate limit."""
    now = time.time()
    entry = join_attempts.get(ip)
    if not entry or now > entry['reset_at']:
        # Purge expired entries when the dict grows too large
        if len(join_attempts) > _MAX_RATE_ENTRIES:
            expired = [k for k, v in join_attempts.items() if now > v['reset_at']]
            for k in expired:
                del join_attempts[k]
        join_attempts[ip] = {'count': 1, 'reset_at': now + 60}
        return False
    entry['count'] += 1
    return entry['count'] > 20


def _is_valid_data_url(value: Any) -> bool:
    """Returns True if value is a string starting with data:image/ within size limit."""
    return (isinstance(value, str)
            and value.startswith('data:image/')
            and len(value) <= _MAX_CANVAS_BYTES)


# ── Handlers ───────────────────────────────────────────────────────────────────

async def on_connect(sid: str, environ: dict, auth: Optional[Any] = None) -> None:
    """Handles new Socket.IO connections and initializes cleanup task."""
    global _cleanup_task
    if _cleanup_task is None or _cleanup_task.done():
        _cleanup_task = asyncio.create_task(_cleanup_loop())

    headers = {k.decode().lower(): v.decode() for k, v in environ.get('headers', [])}
    ip = (headers.get('x-real-ip')
          or headers.get('x-forwarded-for', '').split(',')[0].strip()
          or (environ.get('client') or [''])[0])
    await sio.save_session(sid, {'ip': ip})


async def on_join_room(sid: str, data: Any) -> None:
    """Handles room entry requests, validating credentials and state."""
    from .models import Room, BrushSettings, ChatMessage

    if not isinstance(data, dict):
        await sio.emit('room_error', {'code': 'INVALID', 'message': '入力が不正です'}, to=sid)
        return

    session = await sio.get_session(sid)
    ip = session.get('ip', '')

    if _is_rate_limited(ip):
        await sio.emit('room_error', {
            'code': 'RATE_LIMITED',
            'message': 'リクエストが多すぎます。しばらくしてから試してください。',
        }, to=sid)
        return

    room_id = str(data.get('roomId', '')).strip()
    password = str(data.get('password', ''))
    username = str(data.get('username', '')).strip()[:20]

    if not room_id or not password or not username:
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

    # Clear empty timestamp if user rejoins
    await Room.objects.filter(id=room_id).aupdate(last_emptied_at=None)

    try:
        brush_settings_record = await BrushSettings.objects.aget(username=username)
        brush_settings = brush_settings_record.settings
    except BrushSettings.DoesNotExist:
        brush_settings = None

    # Fetch recent chat history (limit to 50 for payload efficiency)
    chat_history = []
    async for msg in ChatMessage.objects.filter(room_id=room_id).order_by('-created_at')[:50]:
        chat_history.append({
            'userId': msg.user_id,
            'username': msg.username,
            'message': msg.message,
            'time': int(msg.created_at.timestamp() * 1000),
        })
    chat_history.reverse()

    user_id = str(uuid.uuid4())
    if room_id not in active_users:
        active_users[room_id] = {}
    active_users[room_id][sid] = {'id': user_id, 'name': username}

    await sio.save_session(sid, {**session, 'room_id': room_id, 'user_id': user_id, 'username': username})
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
    """Validates and broadcasts drawing operations to other users in the same room."""
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
    """Persists current canvas state to the database."""
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
    """Broadcasts remote cursor movements to other users."""
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
    """Handles incoming chat messages and persists them."""
    from .models import ChatMessage
    if not isinstance(data, dict):
        return
    session = await sio.get_session(sid)
    room_id = session.get('room_id')
    user_id = session.get('user_id')
    username = session.get('username')
    message = str(data.get('message', ''))[:500]
    if not room_id or not message:
        return
    timestamp_ms = int(time.time() * 1000)
    try:
        await ChatMessage.objects.acreate(
            room_id=room_id,
            user_id=user_id,
            username=username,
            message=message,
        )
    except Exception as e:
        logger.error(f'[chat_message] DB insertion failed for room {room_id}: {e}', exc_info=True)
        return
    await sio.emit('chat_message', {
        'userId': user_id,
        'username': username,
        'message': message,
        'time': timestamp_ms,
    }, room=room_id)


async def on_brush_settings(sid: str, data: Any) -> None:
    """Updates user-specific brush settings in the database."""
    from .models import BrushSettings
    if not isinstance(data, dict):
        return
    session = await sio.get_session(sid)
    username = session.get('username')
    settings = data.get('settings')
    if not username or not isinstance(settings, dict):
        return
    if len(json_mod.dumps(settings)) > _MAX_BRUSH_JSON:
        return
    try:
        await BrushSettings.objects.aupdate_or_create(
            username=username,
            defaults={'settings': settings},
        )
    except Exception as e:
        logger.error(f'[brush_settings] DB upsert failed for user {username}: {e}', exc_info=True)


async def on_disconnect(sid: str, reason: Optional[str] = None) -> None:
    """Handles user disconnection, updating room state and notifying others."""
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
