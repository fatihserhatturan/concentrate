import os

import environ

env = environ.Env()

SECRET_KEY = os.environ["DJANGO_SECRET"]
DEBUG = env.bool("DJANGO_DEBUG", default=False)
DATABASES = {"default": env.db("DATABASE_URL")}
ROOT_URLCONF = "config.urls"
STATIC_URL = "static/"
