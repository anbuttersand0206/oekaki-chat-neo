import logging
from django.apps import AppConfig

logger = logging.getLogger(__name__)


class RoomsConfig(AppConfig):
    name = 'rooms'

    def ready(self) -> None:
        """
        Initialization logic for the rooms app.
        Performs a startup cleanup of stale rooms (empty for >30 mins).
        """
        from django.utils import timezone
        from datetime import timedelta
        try:
            from .models import Room
            cutoff = timezone.now() - timedelta(minutes=30)
            deleted, _ = Room.objects.filter(last_emptied_at__lt=cutoff).delete()
            if deleted:
                logger.info(f'Startup Cleanup: Removed {deleted} stale room(s).')
        except Exception as e:
            # We catch all exceptions here to ensure the app still starts even if cleanup fails
            logger.error(f'Startup Cleanup failed: {e}', exc_info=True)
