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
    username = models.CharField(max_length=20, unique=True)
    settings = models.JSONField(default=dict)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'rooms_brushsettings'


class ChatMessage(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='chat_messages')
    user_id = models.CharField(max_length=36)
    username = models.CharField(max_length=20)
    message = models.CharField(max_length=500)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'rooms_chatmessage'
        ordering = ['created_at']
