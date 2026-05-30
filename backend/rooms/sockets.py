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
MAX_BUFFER = 20 * 1024 * 1024  # 20 MB（キャンバス状態の送受信に対応するため大きめに設定）
ROOM_TTL_MINUTES = 30
ROOM_MAX_LIFETIME_HOURS = 24
CLEANUP_INTERVAL_SECONDS = 5 * 60
# セッション再検証の間隔。on_connect 時のみ検証するとセッション失効後も
# WebSocket が切れないため、定期的に再検証してその窓を閉じる。
SESSION_REVALIDATION_INTERVAL_SECONDS = 5 * 60

# ── バリデーション定数 ──────────────────────────────────────────────────────────
_MAX_CANVAS_BYTES = 3 * 1024 * 1024
_MAX_POINTS = 5_000
_MAX_BRUSH_JSON = 64_000
_VALID_OP_TYPES = frozenset({'stroke', 'fill', 'clear', 'paste'})
# 枯渇防止のため IP エントリ数に上限を設ける
_MAX_RATE_ENTRIES = 10_000

sio = socketio.AsyncServer(
    async_mode='asgi',
    cors_allowed_origins=[o.strip() for o in CORS_ORIGIN.split(',') if o.strip()],
    max_http_buffer_size=MAX_BUFFER,
)

# ── インメモリ状態 ──────────────────────────────────────────────────────────────
# active_users: room_id → {sid: {id, name}}  id は str(accounts.User.id)
active_users: dict[str, dict[str, dict[str, str]]] = {}
# join_attempts: ip → {count, reset_at}
join_attempts: dict[str, dict[str, Any]] = {}
# _cleanup_loop と _session_revalidation_loop の両方を管理するフラグ
_background_tasks_started = False


async def _cleanup_loop() -> None:
    from .models import Room
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        try:
            now = timezone.now()
            # 1. 空室になってから 30 分以上経過した部屋を削除
            cutoff_empty = now - timedelta(minutes=ROOM_TTL_MINUTES)
            deleted_empty, _ = await Room.objects.filter(last_emptied_at__lt=cutoff_empty).adelete()

            # 2. 作成から 24 時間以上経過した部屋を削除（絶対的なライフサイクル管理）
            cutoff_age = now - timedelta(hours=ROOM_MAX_LIFETIME_HOURS)
            deleted_old, _ = await Room.objects.filter(created_at__lt=cutoff_age).adelete()

            if deleted_empty or deleted_old:
                logger.info('[cleanup] 削除完了', extra={'deleted_empty': deleted_empty, 'deleted_old': deleted_old})
        except Exception as e:
            logger.error('[cleanup] クリーンアップ中にエラーが発生しました', exc_info=True)


async def _session_revalidation_loop() -> None:
    """接続中の全クライアントの Django セッションを定期的に再検証する。

    on_connect 時のみ検証する設計だと、セッション失効・強制ログアウト後も
    WebSocket 接続が生き続け、描画操作やチャットが継続できてしまう。
    定期再検証でその窓を閉じる。
    """
    while True:
        await asyncio.sleep(SESSION_REVALIDATION_INTERVAL_SECONDS)
        # 反復中に on_disconnect が active_users を変更しても安全なよう
        # スナップショットを先に取る
        all_sids = [
            sid
            for room_sids in list(active_users.values())
            for sid in list(room_sids.keys())
        ]
        for sid in all_sids:
            await _revalidate_session(sid)


async def _revalidate_session(sid: str) -> None:
    """sid の Django セッションを検証し、無効なら WebSocket を切断する。

    _session_revalidation_loop の下位問題として切り出し、
    ループ本体の流れを追いやすくしている。
    """
    try:
        session = await sio.get_session(sid)
        if not session:
            return

        cookie_str = session.get('cookie_str', '')
        # cookie_str がない場合は検証手段がないためスキップする。
        # on_join_room のフォールバック認証パスで接続した場合に
        # セッションに保存されないことがあるため。
        if not cookie_str:
            return

        user = await _get_session_user(cookie_str)
        if user is not None:
            return

        # セッション失効・ユーザー削除・アカウント無効化のいずれか
        logger.info(
            '[session_revalidation] セッション失効のため WebSocket を切断します',
            extra={'sid': sid},
        )
        await sio.disconnect(sid)
    except Exception:
        logger.error(
            '[session_revalidation] セッション検証中にエラーが発生しました',
            extra={'sid': sid},
            exc_info=True,
        )


async def _get_session_user(cookie_str: str):
    """Django セッション Cookie を検証し、認証済み User を返す。無効な場合は None。"""
    from django.contrib.sessions.backends.db import SessionStore
    from django.contrib.auth import get_user_model

    if not cookie_str:
        return None

    try:
        cookies = http.cookies.SimpleCookie()
        cookies.load(cookie_str)
        morsel = cookies.get('sessionid')
        if not morsel:
            return None

        session = SessionStore(session_key=morsel.value)
        # SessionStore はブロッキング I/O なのでスレッドプールに委譲する
        # session.get は第2引数がない場合 None を返す
        auth_user_id = await asyncio.to_thread(session.get, '_auth_user_id')
        if not auth_user_id:
            return None

        User = get_user_model()
        return await User.objects.aget(id=int(auth_user_id), is_active=True)
    except Exception as e:
        # セッション取得失敗はよくある（期限切れ・改ざんなど）ため exc_info でトレースを残す
        logger.error('[get_session_user] セッション取得中にエラーが発生しました', exc_info=True)
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


# ── ハンドラ ────────────────────────────────────────────────────────────────────

async def on_connect(sid: str, environ: dict, auth: Optional[Any] = None) -> None:
    global _background_tasks_started
    # 最初の接続時にバックグラウンドタスクをまとめて起動する。
    # on_connect は複数クライアントから並行して呼ばれるが、asyncio はシングルスレッドで
    # イベントループが await なしに中断されないため、このフラグ確認は競合しない。
    if not _background_tasks_started:
        sio.start_background_task(_cleanup_loop)
        sio.start_background_task(_session_revalidation_loop)
        _background_tasks_started = True

    # python-engineio は ASGI scope の headers を HTTP_* 形式（WSGI-like）に変換して渡す。
    # そのため Cookie は environ['HTTP_COOKIE'] に格納されている。
    ip = (environ.get('HTTP_X_REAL_IP')
          or environ.get('HTTP_X_FORWARDED_FOR', '').split(',')[0].strip()
          or environ.get('REMOTE_ADDR', ''))

    cookie_str = environ.get('HTTP_COOKIE', '')
    user = await _get_session_user(cookie_str)
    
    # cookie_str をセッションに保持しておくことで、on_join_room のフォールバック認証に再利用できる
    session_data = {'ip': ip, 'cookie_str': cookie_str}
    if user:
        session_data.update({
            'auth_user_id': user.id,
            'username': user.username,
        })
    else:
        logger.warning('[connect] 未認証の接続を許可しました（操作時に認証チェック）', extra={'sid': sid})

    await sio.save_session(sid, session_data)
    # 接続を拒否せず、Room 参加時に auth_user_id の有無で権限チェックを行う。
    # これにより、Cookie の不備などで未認証扱いになった場合にクライアントへエラーを返せるようになる。
    return True


async def on_join_room(sid: str, data: Any) -> None:
    from .models import Room, BrushSettings, ChatMessage, UserRoom

    if not isinstance(data, dict):
        await sio.emit('room_error', {'code': 'INVALID', 'message': '入力が不正です'}, to=sid)
        return

    session = await sio.get_session(sid)
    
    # セッションが存在しない、または auth_user_id がない場合は、
    # on_connect 時に保存した cookie_str で再認証を試みる
    if not session or not session.get('auth_user_id'):
        cookie_str = session.get('cookie_str', '') if session else ''
        user = await _get_session_user(cookie_str)
        if user:
            # 認証成功したのでセッションを更新
            auth_user_id = user.id
            username = user.username
            ip = session.get('ip', '') if session else ''
            session = {'ip': ip, 'auth_user_id': auth_user_id, 'username': username}
            await sio.save_session(sid, session)
        else:
            await sio.emit('room_error', {
                'code': 'UNAUTHORIZED',
                'message': '認証セッションが見つかりません。再ログインしてください。'
            }, to=sid)
            return

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

        # bcrypt はブロッキング処理なのでスレッドプールに委譲する
        valid = await asyncio.to_thread(
            bcrypt.checkpw, password.encode(), room.password_hash.encode()
        )
        if not valid:
            await sio.emit('room_error', {'code': 'WRONG_PASSWORD', 'message': 'パスワードが違います'}, to=sid)
            return

        # 誰かが入室したのでクリーンアップ対象から外す
        await Room.objects.filter(id=room_id).aupdate(last_emptied_at=None)

        # ダッシュボード表示のために参加履歴を保存する
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
    except Exception as e:
        logger.error('[on_join_room] 部屋への参加中にエラーが発生しました', extra={'room_id': room_id}, exc_info=True)
        await sio.emit('room_error', {'code': 'INTERNAL_ERROR', 'message': '内部エラーが発生しました'}, to=sid)


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
        logger.error('[canvas_state] DB 更新に失敗しました', extra={'room_id': room_id}, exc_info=True)


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
        logger.error('[chat_message] DB 保存に失敗しました', extra={'room_id': room_id}, exc_info=True)
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
        logger.error('[brush_settings] DB 保存に失敗しました', extra={'user_id': auth_user_id}, exc_info=True)


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
        # 最後の1人が退室したのでクリーンアップ対象としてタイムスタンプを記録する
        active_users.pop(room_id, None)
        await Room.objects.filter(id=room_id).aupdate(last_emptied_at=timezone.now())


# ── ハンドラ登録 ───────────────────────────────────────────────────────────────

def register_handlers() -> None:
    sio.on('connect', on_connect)
    sio.on('disconnect', on_disconnect)
    sio.on('join_room', on_join_room)
    sio.on('draw_op', on_draw_op)
    sio.on('canvas_state', on_canvas_state)
    sio.on('cursor_move', on_cursor_move)
    sio.on('chat_message', on_chat_message)
    sio.on('brush_settings', on_brush_settings)
