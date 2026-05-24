from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True
    dependencies = []

    operations = [
        migrations.CreateModel(
            name='Room',
            fields=[
                ('id', models.CharField(max_length=32, primary_key=True, serialize=False)),
                ('password_hash', models.TextField()),
                ('max_users', models.IntegerField(default=5)),
                ('canvas_state', models.TextField(blank=True, null=True)),
                ('last_emptied_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={'db_table': 'rooms_room'},
        ),
        migrations.CreateModel(
            name='BrushSettings',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('username', models.CharField(max_length=20)),
                ('settings', models.JSONField(default=dict)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('room', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='brush_settings',
                    to='rooms.room',
                )),
            ],
            options={
                'db_table': 'rooms_brushsettings',
                'unique_together': {('room', 'username')},
            },
        ),
    ]
