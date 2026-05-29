from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    email = models.EmailField(unique=True)
    # メール+パスワード認証ユーザーは NULL。Google SSO 経由のみ値が入る
    google_sub = models.CharField(max_length=255, null=True, blank=True, unique=True)
    locale = models.CharField(max_length=10, default='ja')
    timezone = models.CharField(max_length=50, default='Asia/Tokyo')

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = ['username']

    class Meta:
        db_table = 'accounts_user'

    # TODO: プロフィール画像など任意属性は Profile モデルに OneToOneField で追加予定
    #   （db_design_guide_v2.md §3.1 参照）
