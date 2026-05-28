from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    email = models.EmailField(unique=True)
    # Null for email+password users; populated by Google SSO
    google_sub = models.CharField(max_length=255, null=True, blank=True, unique=True)
    locale = models.CharField(max_length=10, default='ja')
    timezone = models.CharField(max_length=50, default='Asia/Tokyo')

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = ['username']

    class Meta:
        db_table = 'accounts_user'

    # Future: add a OneToOneField to a Profile model for profile_picture
    # and other optional per-user attributes (see db_design_guide_v2.md §3.1)
