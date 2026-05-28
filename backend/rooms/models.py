from django.conf import settings
from django.db import models


class Room(models.Model):
    id = models.CharField(max_length=32, primary_key=True)
    password_hash = models.TextField()
    max_users = models.IntegerField(default=5)
    canvas_state = models.TextField(null=True, blank=True)
    last_emptied_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'rooms_room'


class BrushSettings(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='brush_settings',
    )
    settings = models.JSONField(default=dict)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'rooms_brushsettings'


class ChatMessage(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='chat_messages')
    # Nullable because messages sent before auth migration don't have a linked user
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name='chat_messages',
    )
    username = models.CharField(max_length=20)  # denormalized display name
    message = models.CharField(max_length=500)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'rooms_chatmessage'
        ordering = ['created_at']


class UserRoom(models.Model):
    """Tracks which rooms a user has joined (for the dashboard room list)."""
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='user_rooms',
    )
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='user_rooms')
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'rooms_userroom'
        unique_together = ('user', 'room')
        ordering = ['-joined_at']
