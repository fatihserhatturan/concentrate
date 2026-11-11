from functools import lru_cache

from .settings import AppSettings, LegacySettings

settings = AppSettings()


@lru_cache
def get_legacy() -> LegacySettings:
    return LegacySettings()


def secret():
    return settings.secret_key


def connections(config: AppSettings):
    return config.max_connections
