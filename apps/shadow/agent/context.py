"""直接复用原生消息管理器，不维护第二套上下文。"""

from browser_use.agent.message_manager.service import MessageManager

__all__ = ["MessageManager"]
