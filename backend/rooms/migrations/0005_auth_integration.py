"""
Auth integration migration:

- BrushSettings: drop username column, add user OneToOneField
  (existing brush settings data is cleared — no accounts exist yet)
- ChatMessage: drop user_id CharField, add user ForeignKey (nullable)
  (existing chat history is preserved with user=NULL)
- Add UserRoom table for dashboard room membership tracking
"""
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('rooms', '0004_brushsettings_global_per_user'),
        ('accounts', '0001_initial'),
    ]

    operations = [
        # ── BrushSettings: username → user FK ─────────────────────────────────
        # Clear existing data (username cannot be mapped to user accounts)
        migrations.RunSQL(
            sql='DELETE FROM rooms_brushsettings;',
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RemoveField(
            model_name='brushsettings',
            name='username',
        ),
        migrations.AddField(
            model_name='brushsettings',
            name='user',
            field=models.OneToOneField(
                on_delete=django.db.models.deletion.CASCADE,
                related_name='brush_settings',
                to=settings.AUTH_USER_MODEL,
            ),
            preserve_default=False,
        ),

        # ── ChatMessage: user_id CharField → user FK ──────────────────────────
        migrations.RemoveField(
            model_name='chatmessage',
            name='user_id',
        ),
        migrations.AddField(
            model_name='chatmessage',
            name='user',
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='chat_messages',
                to=settings.AUTH_USER_MODEL,
            ),
        ),

        # ── UserRoom ──────────────────────────────────────────────────────────
        migrations.CreateModel(
            name='UserRoom',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('joined_at', models.DateTimeField(auto_now_add=True)),
                ('room', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='user_rooms',
                    to='rooms.room',
                )),
                ('user', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='user_rooms',
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'db_table': 'rooms_userroom',
                'ordering': ['-joined_at'],
            },
        ),
        migrations.AlterUniqueTogether(
            name='userroom',
            unique_together={('user', 'room')},
        ),
    ]
