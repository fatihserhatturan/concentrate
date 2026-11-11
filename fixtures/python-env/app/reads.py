import os
from os import environ, getenv

from decouple import config as decouple_config
from dotenv import dotenv_values, get_key, load_dotenv
from environs import Env

from .keys import REGION_KEY

load_dotenv()
env = Env()
env.read_env()
values = dotenv_values(".env")

PORT = int(os.environ.get("PORT", "8000"))
TIMEOUT = decouple_config("REQUEST_TIMEOUT", default=5, cast=int)
LOCAL_KEY = "LOCAL_FLAG"


def debug():
    return os.environ["DEBUG"] == "1" or "TRACE" in os.environ


def token():
    os.environ["WRITTEN_ONLY"] = "1"
    return getenv("API_TOKEN") or environ.get("FALLBACK_TOKEN")


def region():
    return os.getenv(REGION_KEY)


def local():
    return os.getenv(LOCAL_KEY, "")


def mail():
    return env.str("MAIL_HOST"), env.int("MAIL_PORT", 25), env("MAIL_USER")


def dotenv():
    return values["FROM_DOTENV"], values.get("FROM_DOTENV_2"), get_key(".env", "KEY_FROM_FILE")


def dynamic(name):
    return os.environ.get(name)
