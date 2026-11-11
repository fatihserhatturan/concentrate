MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "shop.middleware.AuditMiddleware",
    "shop.middleware.timing_middleware",
]

ROOT_URLCONF = "shop.urls"
