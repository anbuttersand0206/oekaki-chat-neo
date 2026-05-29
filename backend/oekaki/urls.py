from django.urls import path, include

urlpatterns = [
    path('', include('rooms.urls')),
    path('', include('accounts.urls')),
    # django-allauth の OAuth フロー（Google SSO コールバックなど）
    path('accounts/', include('allauth.urls')),
]
