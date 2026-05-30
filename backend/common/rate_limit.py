import time

from django.http import HttpRequest

# IP エントリが際限なく積み上がってメモリを圧迫しないよう上限を設ける。
# 攻撃者が大量の IP を使い回す DoS シナリオでもヒープが無限に膨らまない。
_MAX_STORE_ENTRIES = 10_000


def get_client_ip(request: HttpRequest) -> str:
    """リクエスト元の IP アドレスを返す。
    リバースプロキシ経由の場合は X-Real-IP / X-Forwarded-For を優先する。
    X-Forwarded-For はカンマ区切りで複数 IP が入る場合があるため先頭のみ使う。
    """
    return (
        request.META.get('HTTP_X_REAL_IP')
        or request.META.get('HTTP_X_FORWARDED_FOR', '').split(',')[0].strip()
        or request.META.get('REMOTE_ADDR', '')
    )


def is_rate_limited(
    ip: str,
    attempts_store: dict[str, list[float]],
    window_seconds: int,
    max_attempts: int,
) -> bool:
    """IP ベースのインメモリレート制限チェック。

    window_seconds 以内の試行回数が max_attempts 以上であれば True を返す。

    DB ではなくインメモリで管理するのは、プロセス再起動でカウンタがリセットされても
    攻撃耐性として十分であり、永続化コストに見合わないため。
    マルチプロセス（Gunicorn 複数ワーカーなど）では各プロセスが独立したカウンタを持つ点に注意。
    """
    now = time.time()
    # ウィンドウ外のタイムスタンプを捨て、有効な試行履歴だけを抽出する
    recent_attempts = [t for t in attempts_store.get(ip, []) if now - t < window_seconds]

    if len(recent_attempts) >= max_attempts:
        # 古いエントリを整理してメモリを解放する（制限中は試行を記録しない）
        attempts_store[ip] = recent_attempts
        return True

    # append してから代入することで、この IP のエントリが空のまま
    # 直後のクリーンアップに誤って刈り取られるのを防ぐ
    recent_attempts.append(now)
    attempts_store[ip] = recent_attempts

    # エントリ数が上限を超えたら使用済み（空）エントリを刈り取ってメモリを解放する
    if len(attempts_store) > _MAX_STORE_ENTRIES:
        stale_ips = [k for k, v in attempts_store.items() if not v]
        for stale_ip in stale_ips:
            del attempts_store[stale_ip]

    return False
