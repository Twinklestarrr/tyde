"""动作描述直接服务于宿主状态展示，不读取页面或回显输入正文。"""

from types import SimpleNamespace

from pydantic import create_model
import pytest


@pytest.mark.parametrize("action, expected", [
    ({"click": {"index": 7}}, "正在点击页面元素"),
    ({"input": {"index": 2, "text": "private-input", "clear": True}}, "正在输入内容"),
    ({"scroll": {"down": True, "pages": 2}}, "正在滚动页面"),
    ({"wait": {"seconds": 3}}, "正在等待"),
    ({"go_back": {}}, "正在返回上一页"),
    ({"switch": {"tab_id": "page_0001"}}, "正在切换标签页"),
    ({"close": {"tab_id": "page_0001"}}, "正在关闭标签页"),
    ({"extract": {"query": "private-query"}}, "正在提取页面内容"),
    ({"send_keys": {"keys": "private-key-sequence"}}, "正在发送按键"),
    ({"request_takeover": {"reason": "login_required"}}, "正在请求人工处理"),
    ({"done": {"text": "unconfirmed-summary", "success": True}}, "正在整理任务结果"),
    ({"future_action": {"private": "private-value"}}, "正在执行操作"),
])
def test_action_description_uses_public_action_type_only(action, expected):
    from api.progress import describe_action

    assert describe_action(SimpleNamespace(action=[action])) == expected


@pytest.mark.parametrize("url, expected", [
    ("https://www.baidu.com", "正在导航 https://www.baidu.com"),
    ("baidu.com", "正在导航 baidu.com"),
    ("  https://example.com/search?q=test#result  ", "正在导航   https://example.com/search?q=test#result  "),
    ("http://example.com:8080/path", "正在导航 http://example.com:8080/path"),
    ("http://localhost:3000", "正在导航 http://localhost:3000"),
    ("localhost:3000", "正在导航 localhost:3000"),
    ("http://192.168.1.10:8080/index.html", "正在导航 http://192.168.1.10:8080/index.html"),
    ("about:blank", "正在导航 about:blank"),
    (None, "正在导航"),
    (123, "正在导航"),
    ("", "正在导航"),
    ("https://", "正在导航 https://"),
    ("file:///private/path", "正在导航 file:///private/path"),
    ("javascript:alert(1)", "正在导航 javascript:alert(1)"),
    ("https://user:private-password@example.com", "正在导航 https://user:private-password@example.com"),
    ("https://example.com:invalid", "正在导航 https://example.com:invalid"),
    ("https://example.com:99999", "正在导航 https://example.com:99999"),
    ("https://example.com/has space", "正在导航 https://example.com/has space"),
    ("https://example.com/has\nnewline", "正在导航 https://example.com/has\nnewline"),
    ("https://example.com/has\\backslash", "正在导航 https://example.com/has\\backslash"),
])
def test_navigation_description_uses_model_target_verbatim(url, expected):
    from api.progress import describe_action

    assert describe_action(SimpleNamespace(action=[{"navigate": {"url": url}}])) == expected


@pytest.mark.parametrize("output", [
    None,
    SimpleNamespace(),
    SimpleNamespace(action=None),
    SimpleNamespace(action=[]),
    SimpleNamespace(action=[{}]),
    SimpleNamespace(action=[None, {"click": None}]),
])
def test_empty_action_has_no_message_update(output):
    from api.progress import describe_action

    assert describe_action(output) is None


def test_description_reads_native_model_shape_and_first_nonempty_action():
    from api.progress import describe_action

    Action = create_model("ProgressAction", click=(dict | None, None), navigate=(dict | None, None))
    output = SimpleNamespace(action=[Action(), Action(navigate={"url": "baidu.com"})])

    assert describe_action(output) == "正在导航 baidu.com"


@pytest.mark.parametrize("params, expected", [
    (None, None),
    ("private-malformed-parameters", "正在导航"),
    (["private-value"], "正在导航"),
])
def test_malformed_navigation_parameters_do_not_break_progress(params, expected):
    from api.progress import describe_action

    assert describe_action(SimpleNamespace(action=[{"navigate": params}])) == expected
