from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class BaseAppSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="APP_", env_file=".env")

    debug: bool = False
    secret_key: str = Field("x", validation_alias="SERVICE_SECRET")
    database_url: str = ""


class AppSettings(BaseAppSettings):
    max_connections: int = 10
    cache_url: str = Field("", env="CACHE_URL")


class LegacySettings(BaseSettings):
    name: str = "x"

    class Config:
        env_prefix = "legacy_"
