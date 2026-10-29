"""核验原生模型配置、动态动作输出与提示词扩展，不调用远程模型。"""

import pytest
import httpx
import json
from pydantic import BaseModel
from pydantic import ValidationError

from config.settings import Settings


@pytest.fixture
def modules(tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR", str(tmp_path / "vendor-config"))
    monkeypatch.setenv("BROWSER_USE_SETUP_LOGGING", "false")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "false")
    from agent import context, judge, planner, prompts, views

    return context, judge, planner, prompts, views


@pytest.mark.parametrize("provider", ["deepseek", "openai"])
def test_native_model_receives_explicit_credentials_model_and_timeout(modules, provider):
    _, judge, planner, _, _ = modules
    config = Settings(_env_file=None, LLM_PROVIDER=provider, LLM_API_KEY="test-private-key",
                      LLM_MODEL_NAME="main-model", JUDGE_MODEL_NAME="judge-model", LLM_TIMEOUT=37)
    assert hasattr(planner, "build_llm"), "模型构造尚未实现"
    assert hasattr(judge, "build_judge_llm"), "Judge 配置尚未实现"

    model = planner.build_llm(config)
    evaluator = judge.build_judge_llm(config)

    assert (model.provider, model.model, model.api_key, model.timeout) == (provider, "main-model", "test-private-key", 37)
    assert (evaluator.provider, evaluator.model, evaluator.api_key, evaluator.timeout) == (provider, "judge-model", "test-private-key", 37)


@pytest.mark.parametrize("provider, key", [("unsupported", "private-key"), ("deepseek", ""), ("openai", "   ")])
def test_bad_model_configuration_is_rejected_without_printing_secrets(modules, provider, key):
    planner = modules[2]
    assert hasattr(planner, "build_llm"), "模型构造尚未实现"
    with pytest.raises(ValueError) as error:
        planner.build_llm(Settings(_env_file=None, LLM_PROVIDER=provider, LLM_API_KEY=key))
    assert "private-key" not in str(error.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["main", "judge"])
@pytest.mark.parametrize("name", ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"])
async def test_deepseek_structured_request_explicitly_disables_thinking(modules, role, name):
    from browser_use.llm import ChatDeepSeek
    from browser_use.llm.messages import UserMessage

    class Probe(BaseModel):
        answer: str

    requests = []

    def respond(request):
        payload = json.loads(request.content)
        requests.append(payload)
        if payload.get("thinking") != {"type": "disabled"}:
            return httpx.Response(400, json={"error": {"message": "Thinking mode does not support this tool_choice",
                "type": "invalid_request_error", "code": "invalid_request_error"}})
        return httpx.Response(200, json={"id": "test-completion", "object": "chat.completion", "created": 0,
            "model": name, "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": None, "tool_calls": [{"id": "test-call", "type": "function",
                    "function": {"name": "Probe", "arguments": '{"answer":"OK"}'}}]}}]})

    config = Settings(_env_file=None, LLM_PROVIDER="deepseek", LLM_API_KEY="test-private-key",
        LLM_MODEL_NAME=name, JUDGE_MODEL_NAME=name)
    client = modules[2].build_llm(config) if role == "main" else modules[1].build_judge_llm(config)
    assert isinstance(client, ChatDeepSeek)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as transport:
        client.client_params = {"http_client": transport, "max_retries": 0}
        output = await client.ainvoke([UserMessage(content="请返回 answer=OK")], output_format=Probe)
    assert output.completion.answer == "OK"
    assert len(requests) == 1
    assert requests[0]["model"] == name and requests[0]["thinking"] == {"type": "disabled"}
    assert requests[0]["tool_choice"] == {"type": "function", "function": {"name": "Probe"}}


@pytest.mark.parametrize("mode", ["type_with_custom_actions", "type_with_custom_actions_no_thinking", "type_with_custom_actions_flash_mode"])
def test_timing_extension_keeps_native_action_schema_in_all_modes(modules, mode):
    views = modules[-1]
    assert hasattr(views, "extend_output_model"), "逐步输出扩展尚未实现"
    from browser_use.agent.views import AgentOutput
    from browser_use.tools.service import Tools

    actions = Tools().registry.create_action_model(include_actions=["click", "done"])
    original = getattr(AgentOutput, mode)(actions)
    output = views.extend_output_model(original)
    parsed = output.model_validate({"action": [{"click": {"index": 2}}], "read_time_ms": 150, "action_type": "click"})

    assert parsed.action[0].get_index() == 2
    assert parsed.read_time_ms == 150
    schema = output.model_json_schema()
    assert schema["properties"]["action"] == original.model_json_schema()["properties"]["action"]
    assert ("thinking" in schema["properties"]) == ("thinking" in original.model_json_schema()["properties"])
    assert {"read_time_ms", "action_type"} <= schema["properties"].keys()
    with pytest.raises(ValidationError):
        output.model_validate({"action": [{"evaluate": {"code": "bad"}}]})
    with pytest.raises(ValidationError):
        output.model_validate({"action": [{"click": {"index": 2}}], "read_time_ms": -1})


def test_prompt_appends_protocol_and_skills_without_replacing_native_prompt(modules):
    prompts = modules[3]
    assert hasattr(prompts, "build_system_prompt"), "提示词扩展尚未实现"
    result = prompts.build_system_prompt("原生系统提示", ["技能甲", "技能乙"])
    assert result.startswith("原生系统提示\n")
    assert result.count(prompts.RHYTHM_PROTOCOL) == 1
    assert result.endswith("技能甲\n技能乙")


def test_context_exports_the_native_message_manager(modules):
    context = modules[0]
    assert hasattr(context, "MessageManager"), "上下文导出尚未实现"
    from browser_use.agent.message_manager.service import MessageManager

    assert context.MessageManager is MessageManager
