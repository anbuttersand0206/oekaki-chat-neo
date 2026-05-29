import logging
from django.apps import AppConfig

logger = logging.getLogger(__name__)


class RoomsConfig(AppConfig):
    name = 'rooms'

    def ready(self) -> None:
        """アプリ起動時に古い部屋（30 分以上空室）を一括削除する。

        サーバー再起動後も不要な部屋が残り続けることを防ぐための起動時クリーンアップ。
        失敗してもサーバーは起動を続ける（クリーンアップは必須処理ではないため）。
        """
        from django.utils import timezone
        from datetime import timedelta
        try:
            from .models import Room
            cutoff = timezone.now() - timedelta(minutes=30)
            deleted, _ = Room.objects.filter(last_emptied_at__lt=cutoff).delete()
            if deleted:
                logger.info(f'起動時クリーンアップ: 古い部屋を {deleted} 件削除しました')
        except Exception as e:
            logger.error(f'起動時クリーンアップに失敗しました: {e}', exc_info=True)
