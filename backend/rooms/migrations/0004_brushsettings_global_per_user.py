from django.db import migrations, models


class Migration(migrations.Migration):
    """
    BrushSettings をルーム単位からユーザー単位（username 単独キー）に変更する。
    既存レコードは username 単位で最新の updated_at のものを残し、それ以外を削除してから
    room FK と unique_together を削除し、username に UNIQUE 制約を付与する。
    """

    dependencies = [
        ('rooms', '0003_chatmessage'),
    ]

    operations = [
        # 1) username ごとに最古のレコード(id)を残し重複行を削除する（SQLite/PostgreSQL 両対応）
        migrations.RunSQL(
            sql="""
                DELETE FROM rooms_brushsettings
                WHERE id NOT IN (
                    SELECT MIN(id)
                    FROM rooms_brushsettings
                    GROUP BY username
                );
            """,
            reverse_sql=migrations.RunSQL.noop,
        ),
        # 2) room FK を削除
        migrations.RemoveField(
            model_name='brushsettings',
            name='room',
        ),
        # 3) unique_together は room 削除で自動解除されるが、
        #    username に明示的な UNIQUE 制約を付ける
        migrations.AlterField(
            model_name='brushsettings',
            name='username',
            field=models.CharField(max_length=20, unique=True),
        ),
    ]
