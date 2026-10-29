"""将项目配置映射为 browser-use 原生模型客户端。"""

from browser_use.llm import ChatDeepSeek, ChatOpenAI

from config.settings import Settings, settings


class _DeepSeekClient(ChatDeepSeek):
    """补齐原库对当前 Flash 名称的识别，使非思考模式开关实际发出。"""

    def _supports_thinking(self) -> bool:
        return self.model.lower() == "deepseek-flash" or super()._supports_thinking()


def supports_deepseek_vision(llm) -> bool:
    """仅放行官方支持图片的 Flash 名称及兼容别名。"""
    return llm.provider == "deepseek" and llm.model.lower() in {
        "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp",
    }


def build_llm(config: Settings | None = None, *, model: str | None = None):
    """统一使用 LLM_API_KEY。"""
    config = config if config is not None else settings
    clients = {"deepseek": _DeepSeekClient, "openai": ChatOpenAI}
    provider = config.LLM_PROVIDER.strip().lower()
    if provider not in clients:
        raise ValueError("LLM_PROVIDER 仅支持 deepseek 或 openai")
    if not config.LLM_API_KEY.strip():
        raise ValueError("调用模型前必须配置 LLM_API_KEY")
    model_name = model if model is not None else config.LLM_MODEL_NAME
    if not model_name.strip():
        raise ValueError("模型名称不能为空")
    return clients[provider](model=model_name, api_key=config.LLM_API_KEY, timeout=config.LLM_TIMEOUT)
