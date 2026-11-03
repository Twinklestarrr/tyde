"""发布包自检：加载实际依赖和提示词，不联网、不启动浏览器或操作桌面。"""

from importlib import import_module
import sys


def check_runtime() -> None:
    from agent.judge import build_judge_llm
    from agent.planner import build_llm
    from browser_use.agent.prompts import SystemPrompt
    from config.settings import Settings

    import_module("agent.loop")
    for name in ("pyautogui", "mss", "pynput.keyboard", "pynput.mouse"):
        import_module(name)
    if sys.platform == "darwin":
        for name in ("AppKit", "Quartz", "ApplicationServices", "mss.darwin"):
            import_module(name)
    for options in ({}, {"use_thinking": False}, {"flash_mode": True}):
        SystemPrompt(**options).get_system_message()
    for provider in ("deepseek", "openai"):
        config = Settings(_env_file=None, LLM_PROVIDER=provider, LLM_API_KEY="runtime-check-placeholder")
        build_llm(config)
        build_judge_llm(config)
