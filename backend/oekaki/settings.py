import os
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEBUG = os.environ.get('DEBUG', 'false').lower() == 'true'

# SECURITY WARNING: keep the secret key used in production secret!
SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY')
if not SECRET_KEY:
    if DEBUG:
        SECRET_KEY = 'dev-only-insecure-key-change-in-production'
    else:
        raise ImproperlyConfigured("The DJANGO_SECRET_KEY environment variable must be set in production.")

_allowed_hosts_raw = os.environ.get('ALLOWED_HOSTS', '')
if not _allowed_hosts_raw:
    if DEBUG:
        _allowed_hosts_raw = 'localhost,127.0.0.1'
    else:
        raise ImproperlyConfigured("The ALLOWED_HOSTS environment variable must be set in production.")
ALLOWED_HOSTS = [h.strip() for h in _allowed_hosts_raw.split(',') if h.strip()]

INSTALLED_APPS = [
    'django.contrib.contenttypes',
    'corsheaders',
    'rooms',
]

MIDDLEWARE = [
    # CorsMiddleware must be as high as possible, especially before any middleware that can generate responses
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.common.CommonMiddleware',
]

ROOT_URLCONF = 'oekaki.urls'
ASGI_APPLICATION = 'oekaki.asgi.application'

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'HOST': os.environ.get('PGHOST', 'localhost'),
        'PORT': os.environ.get('PGPORT', '5432'),
        'NAME': os.environ.get('PGDATABASE', 'oekaki'),
        'USER': os.environ.get('PGUSER', 'oekaki'),
        'PASSWORD': os.environ.get('PGPASSWORD', ''),
    }
}

USE_TZ = True
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

CORS_ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get('CORS_ORIGIN', 'http://localhost:8080').split(',') if o.strip()
]
