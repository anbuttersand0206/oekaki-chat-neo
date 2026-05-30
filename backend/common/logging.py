import json
import logging
from datetime import datetime, timezone


# LogRecord が標準で持つ属性名。extra= で渡されたフィールドと区別するために使う。
# Python が format() 処理中に追加する message / asctime も含めて除外対象にする。
_STANDARD_LOG_RECORD_FIELDS = frozenset({
    'args', 'asctime', 'created', 'exc_info', 'exc_text', 'filename',
    'funcName', 'levelname', 'levelno', 'lineno', 'message', 'module',
    'msecs', 'msg', 'name', 'pathname', 'process', 'processName',
    'relativeCreated', 'stack_info', 'taskName', 'thread', 'threadName',
})


class JsonFormatter(logging.Formatter):
    """ログレコードを JSON Lines 形式にシリアライズするフォーマッター。

    f-string でユーザー入力をそのまま埋め込むと、\n・\r を含む値で
    ログエントリの行境界を破壊できる（Log Injection）。
    json.dumps は制御文字を Unicode エスケープ（\n → \\n）に変換するため、
    フィールド値にどんな文字列が来てもログの構造を壊せなくなる。

    出力例（1 イベント = 1 行）:
    {"time": "2024-01-15T10:30:00.123+00:00", "level": "INFO",
     "logger": "accounts.views", "func": "register_view", "line": 127,
     "message": "新規ユーザーが登録されました", "email": "user@example.com"}
    """

    def format(self, record: logging.LogRecord) -> str:
        entry: dict = {
            'time': datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(timespec='milliseconds'),
            'level': record.levelname,
            'logger': record.name,
            'func': record.funcName,
            'line': record.lineno,
            'message': record.getMessage(),
        }

        # extra= で渡されたフィールドだけを追加する（標準フィールドは上書きさせない）
        for key, value in record.__dict__.items():
            if key not in _STANDARD_LOG_RECORD_FIELDS:
                entry[key] = value

        if record.exc_info:
            entry['exc_info'] = self.formatException(record.exc_info)

        # ensure_ascii=False: 日本語をそのまま出力する（\uXXXX エスケープにしない）
        # default=str: json.dumps が扱えない型（Django モデル等）を文字列化してクラッシュを防ぐ
        return json.dumps(entry, ensure_ascii=False, default=str)
