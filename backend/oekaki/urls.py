from django.urls import path, include

urlpatterns = [
    path('', include('rooms.urls')),
    path('', include('accounts.urls')),
    path('accounts/', include('allauth.urls')),
]
