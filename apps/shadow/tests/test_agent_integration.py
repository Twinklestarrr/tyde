"""显式授权后，用确定性模型验证原生 Agent 到 OS 的真实执行链路。"""

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading

import pytest

from browser import session as session_module
from config.settings import Settings


TEXT = "Shadow 中文 😀!?\n下一行"
HTML = """<!doctype html><meta charset="utf-8"><title>Shadow Agent 本地验收</title>
<style>body{margin:0;height:3000px}#target{position:fixed;left:120px;top:160px;width:200px;height:90px}
#text{position:fixed;left:120px;top:290px;width:300px;height:120px}
iframe{position:fixed;left:500px;top:160px;width:300px;height:220px}</style>
<button id="target" data-clicks="0" onclick="this.dataset.clicks=Number(this.dataset.clicks)+1;this.style.background='orange'">本地按钮</button>
<textarea id="text">旧文</textarea><iframe src="/frame"></iframe>"""
FRAME = """<!doctype html><meta charset="utf-8"><button id="frame-target" style="margin:25px;width:150px;height:60px"
onclick="parent.document.body.dataset.frameClicked='1'">框架内按钮</button>"""


@pytest.fixture
def agent_site():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = (FRAME if self.path == "/frame" else HTML).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type","text/html; charset=utf-8")
            self.send_header("Content-Length",str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self,*args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1",0),Handler)
    thread = threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.asyncio
async def test_native_agent_registry_to_os_and_history(tmp_path,monkeypatch,request):
    if os.environ.get("SHADOW_OS_INTEGRATION") != "1":
        pytest.skip("显式启用 SHADOW_OS_INTEGRATION=1 后才启动 Agent 桌面验收")
    executable = os.environ.get("SHADOW_BROWSER_EXECUTABLE")
    assert executable and Path(executable).is_file()
    monkeypatch.setenv("BROWSER_USE_CONFIG_DIR",str(tmp_path / "vendor-config"))
    monkeypatch.setenv("BROWSER_USE_SETUP_LOGGING","false")
    monkeypatch.setenv("ANONYMIZED_TELEMETRY","false")
    from agent.loop import ShadowAgent

    config = Settings(_env_file=None,VERIFY_SCREENSHOT=True,
        HISTORY_SAVE_PATH=str(tmp_path / "sessions"),HISTORY_SAVE_INTERVAL=2,SAVE_GIF=True)
    monkeypatch.setattr(session_module,"PROJECT_ROOT",tmp_path)
    profile = tmp_path / "config/profiles/account_001"
    profile.mkdir(parents=True)
    (profile / "browser_profile.json").write_text(json.dumps({
        "user_data_dir":"config/profiles/account_001/chrome_data","executable_path":executable,
        "viewport":None,"window_size":{"width":1000,"height":750},
        "window_position":{"width":100,"height":100},
        "enable_default_extensions":False,"captcha_solver":False,
    }),encoding="utf-8")
    observed, final_state = [], {}
    cdp_actions = []

    async def on_event(event):
        observed.append(event)

    session = session_module.create_session(on_event=on_event)

    class ScriptedModel:
        """只替代远程决策，保留真实 Agent、动作模型与浏览器执行。"""

        model = name = model_name = "scripted-deepseek"
        provider = "deepseek"
        _verified_api_keys = True

        def __init__(self):
            self.agent = None
            self.calls = 0
            self.url = None
            self.original_tab = self.secondary_tab = None

        async def ainvoke(self,messages,output_format=None,**kwargs):
            from browser_use.llm.views import ChatInvokeCompletion

            # 端口和页面仅在接管确认已通过、原生 Agent 开始运行后创建。
            if self.url is None:
                port = request.getfixturevalue("agent_site")
                self.url = f"http://127.0.0.1:{port}"
            self.calls += 1
            if self.calls == 1:
                from browser_use.browser.events import NavigateToUrlEvent, GoBackEvent, SwitchTabEvent, CloseTabEvent

                async def record_cdp_action(event):
                    cdp_actions.append(type(event).__name__)

                for event_type in (NavigateToUrlEvent, GoBackEvent, SwitchTabEvent, CloseTabEvent):
                    session.event_bus.on(event_type, record_cdp_action)
                self.original_tab = session.agent_focus_target_id[-4:]
            if self.calls == 11:
                self.secondary_tab = session.agent_focus_target_id[-4:]
            actions = [
                ("navigate",{"url":self.url}),
                ("navigate",{"url":self.url.replace("127.0.0.1","localhost") + "/other-host"}),
                ("navigate",{"url":self.url}),
                ("click",{"id":"target"}),
                ("input",{"id":"text","text":TEXT,"clear":True}),
                ("input",{"id":"text","text":" 追加","clear":False}),
                ("scroll",{"pages":0.5,"down":True}),
                ("click",{"id":"frame-target"}),
                ("click",{"id":"target"}),
                ("navigate",{"url":self.url + "/second","new_tab":True}),
                ("navigate",{"url":self.url + "/third"}),
                ("go_back",{}),
                ("switch",{"tab_id":self.original_tab}),
                ("close",{"tab_id":self.secondary_tab}),
                ("done",{"text":"本地链路验收完成","success":True}),
            ]
            assert self.calls <= len(actions), "原生 Agent 发生了未预期的模型调用或重试"
            name, params = actions[self.calls-1]
            params = dict(params)
            if "id" in params:
                element_id = params.pop("id")
                mapping = self.agent.browser_session._cached_browser_state_summary.dom_state.selector_map
                params["index"] = next(index for index,node in mapping.items() if node.attributes.get("id") == element_id)
            print("本地 Agent 动作：",self.calls,name)
            timing_type = {"input":"type","navigate":"navigate","click":"click","scroll":"scroll"}.get(name)
            payload = {"memory":"仅处理本地测试页","evaluation_previous_goal":"检查上一动作", "next_goal":name,
                "action":[{name:params}],"read_time_ms":0,"action_type":timing_type}
            return ChatInvokeCompletion(completion=output_format.model_validate(payload),usage=None)

    model = ScriptedModel()

    async def inspect_done(state,output,step):
        if output.action[0].model_dump().get("done"):
            page = await session.get_current_page()
            final_state.update(json.loads(await page.evaluate("""() => ({
                text:document.querySelector('#text').value,
                clicks:Number(document.querySelector('#target').dataset.clicks),
                frame:document.body.dataset.frameClicked,scroll:window.scrollY
            })""")))

    agent = ShadowAgent(task="验证本地页面的 OS 动作",browser_session=session,llm=model,config=config,
        audit_path=tmp_path / "audit.log",
        task_id="native-agent",use_judge=False,use_vision=False,enable_planning=False,message_compaction=False,
        directly_open_url=False,enable_signal_handler=False,register_new_step_callback=inspect_done,
        file_system_path=str(tmp_path / "vendor-files"))
    model.agent = agent
    try:
        result = await agent.run(max_steps=18)
        assert result.is_done() and result.is_successful(), result.errors()
        assert final_state["text"] == TEXT + " 追加"
        assert final_state["clicks"] == 2 and final_state["frame"] == "1" and final_state["scroll"] > 0
        assert all(not error for error in result.errors())
        assert cdp_actions == [], "业务动作或主动关闭不能触发原生 CDP 导航、后退、切换或关闭"
        archive = tmp_path / "sessions/native-agent"
        saved = json.loads((archive / "history.json").read_text(encoding="utf-8"))
        assert saved["history"][-1]["model_output"]["read_time_ms"] == 0
        assert (archive / "recording.gif").is_file()
        assert len(list(archive.glob("step_*.png"))) >= 8
        print("本地 Agent 最终状态：",final_state)
    finally:
        agent.os_controller.revoke()
        await session.kill()
