"""将下一步动作转成宿主可展示的描述，不读取页面或回显输入正文。"""

from collections.abc import Mapping


_ACTION_MESSAGES = {
    "click": "正在点击页面元素",
    "input": "正在输入内容",
    "scroll": "正在滚动页面",
    "wait": "正在等待",
    "go_back": "正在返回上一页",
    "switch": "正在切换标签页",
    "close": "正在关闭标签页",
    "extract": "正在提取页面内容",
    "send_keys": "正在发送按键",
    "request_takeover": "正在请求人工处理",
    "done": "正在整理任务结果",
}


def _navigation_message(params):
    url = params.get("url") if isinstance(params, Mapping) else None
    if not isinstance(url, str) or not url:
        return "正在导航"
    return f"正在导航 {url}"


def describe_action(model_output) -> str | None:
    """读取原生动作模型或字典中的首个非空动作；空输出保留原消息。"""
    for action in getattr(model_output, "action", None) or []:
        if hasattr(action, "model_dump"):
            action = action.model_dump(exclude_none=True)
        if not isinstance(action, Mapping):
            continue
        for name, params in action.items():
            if params is None:
                continue
            if name == "navigate":
                return _navigation_message(params)
            return _ACTION_MESSAGES.get(name, "正在执行操作")
    return None
