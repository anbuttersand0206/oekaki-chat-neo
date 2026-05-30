import os
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEBUG = os.environ.get('DEBUG', 'false').lower() == 'true'

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
    'django.contrib.auth',
    'django.contrib.sessions',
    'corsheaders',
    'allauth',
    'allauth.account',
    'allauth.socialaccount',
    'allauth.socialaccount.providers.google',
    'rooms',
    'accounts',
]

MIDDLEWARE = [
    # CorsMiddleware はプリフライトリクエストを最初に処理するため先頭に置く必要がある
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'allauth.account.middleware.AccountMiddleware',
]

ROOT_URLCONF = 'oekaki.urls'
ASGI_APPLICATION = 'oekaki.asgi.application'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [os.path.join(BASE_DIR, 'templates')],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
            ],
        },
    },
]

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

# ── Auth ──────────────────────────────────────────────────────────────────────

AUTH_USER_MODEL = 'accounts.User'

AUTHENTICATION_BACKENDS = [
    'allauth.account.auth_backends.AuthenticationBackend',
]

# ── Session ───────────────────────────────────────────────────────────────────

SESSION_ENGINE = 'django.contrib.sessions.backends.db'
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Lax'
SESSION_COOKIE_AGE = 60 * 60 * 24 * 30  # 30日
# スライディング・ウィンドウ方式: リクエストのたびに有効期限を SESSION_COOKIE_AGE 分延長する
SESSION_SAVE_EVERY_REQUEST = True

# ── django-allauth ────────────────────────────────────────────────────────────

ACCOUNT_EMAIL_REQUIRED = True
ACCOUNT_USERNAME_REQUIRED = True
ACCOUNT_AUTHENTICATION_METHOD = 'email'
# TODO: 本番運用前に 'mandatory' へ変更してメール認証を必須にすること。
#   'optional' のままでは /api/auth/register で登録したアカウントが
#   メール確認なしで即座に有効化される。
#   変更後は accounts/views.py の register_view も allauth の確認メール
#   送信フローと整合させる必要がある。（README §TODO 参照）
ACCOUNT_EMAIL_VERIFICATION = 'optional'
ACCOUNT_DEFAULT_HTTP_PROTOCOL = 'http' if DEBUG else 'https'

SOCIALACCOUNT_AUTO_SIGNUP = True
SOCIALACCOUNT_LOGIN_ON_GET = True   # 「ソーシャルログイン確認」中間ページをスキップする
SOCIALACCOUNT_STORE_TOKENS = False

SOCIALACCOUNT_PROVIDERS = {
    'google': {
        'APP': {
            'client_id': os.environ.get('GOOGLE_CLIENT_ID', ''),
            'secret': os.environ.get('GOOGLE_CLIENT_SECRET', ''),
            'key': '',
        },
        'SCOPE': ['profile', 'email'],
        'AUTH_PARAMS': {'access_type': 'online'},
    }
}

LOGIN_REDIRECT_URL = '/'
ACCOUNT_LOGOUT_REDIRECT_URL = '/'

# ── メール ────────────────────────────────────────────────────────────────────
# 本番では EMAIL_BACKEND 環境変数に SMTP バックエンドを指定すること。
# 例: EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend

EMAIL_BACKEND = os.environ.get(
    'EMAIL_BACKEND',
    'django.core.mail.backends.console.EmailBackend',
)
EMAIL_HOST = os.environ.get('EMAIL_HOST', 'smtp.example.com')
EMAIL_PORT = int(os.environ.get('EMAIL_PORT', '587'))
EMAIL_USE_TLS = os.environ.get('EMAIL_USE_TLS', 'true').lower() == 'true'
EMAIL_HOST_USER = os.environ.get('EMAIL_HOST_USER', '')
EMAIL_HOST_PASSWORD = os.environ.get('EMAIL_HOST_PASSWORD', '')
DEFAULT_FROM_EMAIL = os.environ.get('DEFAULT_FROM_EMAIL', 'noreply@example.com')

# ── CORS ──────────────────────────────────────────────────────────────────────

CORS_ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get('CORS_ORIGIN', 'http://localhost:8080').split(',') if o.strip()
]
CORS_ALLOW_CREDENTIALS = True

# ── ロギング ──────────────────────────────────────────────────────────────────
# 全ハンドラで JsonFormatter を使い、Log Injection をフォーマット層で無効化する。
# ユーザー入力は extra= フィールドとして渡し、json.dumps の制御文字エスケープで保護する。
# disable_existing_loggers=False で Django 標準ロガーは残しつつ、
# アプリ固有ロガーだけ INFO 以上で取得する（propagate=False で二重出力を防ぐ）。
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'json': {
            '()': 'common.logging.JsonFormatter',
        },
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            'formatter': 'json',
        },
    },
    'root': {
        'handlers': ['console'],
        # Django フレームワーク自体のノイズを抑えるため WARNING 以上のみ出す
        'level': 'WARNING',
    },
    'loggers': {
        'accounts': {
            'handlers': ['console'],
            'level': 'DEBUG' if DEBUG else 'INFO',
            # root に propagate しないことで二重出力を防ぐ
            'propagate': False,
        },
        'rooms': {
            'handlers': ['console'],
            'level': 'DEBUG' if DEBUG else 'INFO',
            'propagate': False,
        },
        'common': {
            'handlers': ['console'],
            'level': 'DEBUG' if DEBUG else 'INFO',
            'propagate': False,
        },
    },
}
