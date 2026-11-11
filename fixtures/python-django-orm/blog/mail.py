from django.conf import settings


def sender():
    return settings.SECRET_KEY


def debug_mode():
    return settings.DEBUG or settings.STATIC_URL
