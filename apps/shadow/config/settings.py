"""从环境变量和运行目录的 .env 文件读取应用配置。"""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from config.runtime import PROJECT_ROOT


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
    )

    # 模型配置：所有模型提供方统一使用 LLM_API_KEY 读取密钥。
    LLM_PROVIDER: str = "deepseek"
    LLM_MODEL_NAME: str = "deepseek-flash"
    LLM_API_KEY: str = Field(default="", repr=False)
    LLM_TIMEOUT: int = Field(default=60, gt=0)
    JUDGE_MODEL_NAME: str = "deepseek-flash"

    # 行为节奏
    READ_TIME_JITTER: float = Field(default=0.2, ge=0, le=1)
    MIN_ACTION_DELAY_MS: int = Field(default=500, ge=0)

    # 执行控制
    OS_CHANNEL_TIMEOUT: int = Field(default=30, gt=0)
    PAGE_LOAD_TIMEOUT: int = Field(default=30, gt=0)
    VERIFY_SCREENSHOT: bool = True

    # 历史存档
    SAVE_HISTORY: bool = True
    HISTORY_SAVE_PATH: str = str(PROJECT_ROOT / "data" / "sessions")
    HISTORY_SAVE_INTERVAL: int = Field(default=10, ge=0)
    SAVE_GIF: bool = False

    # 本地宿主通信：部署时可通过环境变量覆盖文件路径。
    API_HOST: str = "127.0.0.1"
    API_PORT: int = Field(default=29321, ge=1, le=65535)
    TOKEN_FILE_PATH: str = str(PROJECT_ROOT / "data" / "agent_token.txt")
    PID_FILE_PATH: str = str(PROJECT_ROOT / "data" / "agent.pid")


settings = Settings()
