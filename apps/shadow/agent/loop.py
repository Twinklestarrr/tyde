"""保留原生决策循环，接入 OS 动作、接管授权、节奏输出与项目存档。"""

import asyncio
import inspect
from contextlib import suppress
from uuid import uuid4

from browser_use.agent.service import Agent
from browser_use.agent.prompts import AgentMessagePrompt
from browser_use.agent.views import ActionResult, AgentOutput
from browser_use.llm.messages import SystemMessage

from agent.controller import OSController
from agent.judge import build_judge_llm
from agent.memory.history import HistoryRecorder, maybe_save_history
from agent.planner import build_llm, supports_deepseek_vision
from agent.prompts import RESUME_CHECK_PROTOCOL, build_system_prompt
from agent.views import extend_output_model
from auth.audit import AuditError, AuditLog
from config.settings import Settings, settings
from core.orchestrator.rhythm import RhythmEngine
from core.orchestrator.takeover import ResumeCheck, ResumeConflictError, ResumeFatalError, TakeoverManager


class ShadowAgent(Agent):
    """每次任务创建新实例；授权失败时不进入原生运行流程。"""

    def __init__(self, task: str, browser_session, *, tools=None, llm=None,
                 config: Settings | None = None, orchestrator=None,
                 task_id: str | None = None, account_id: str | None = None,
                 audit_path=None, skill_extensions=None, **kwargs):
        self.config = config if config is not None else settings
        self.os_controller = tools if tools is not None else OSController(config=self.config)
        if not isinstance(self.os_controller, OSController):
            raise ValueError("ShadowAgent 必须使用 OSController，不能接入原生 CDP 交互工具表")
        if kwargs.get("controller") is not None:
            raise ValueError("请通过 tools 传入 OSController")
        if kwargs.get("max_actions_per_step",1) != 1:
            raise ValueError("第一版每步仅支持一个动作，以对应本步阅读时长")
        output_schema = kwargs.get("output_model_schema")
        if output_schema is not None and issubclass(output_schema, AgentOutput):
            raise ValueError("output_model_schema 定义最终结果，不能传入每步动作模型")
        if kwargs.get("skill_service") is not None or kwargs.get("skills") or kwargs.get("skill_ids"):
            raise ValueError("第一版技能接入留待后续步骤，不能注册未经 OS 覆盖的交互动作")
        if kwargs.get("generate_gif") or kwargs.get("save_conversation_path"):
            raise ValueError("请通过项目历史配置控制存档")
        self.orchestrator = orchestrator
        self.rhythm = RhythmEngine(config=self.config)
        self._user_step_callback = kwargs.pop("register_new_step_callback",None)
        self._has_run = False
        self._run_task: asyncio.Task | None = None
        task_id = task_id or str(uuid4())
        self.audit = AuditLog(task_id, account_id, path=audit_path, on_failure=self.os_controller.revoke)
        self.takeover = TakeoverManager(task_id, self.os_controller.revoke, audit=self.audit)
        self.recorder = HistoryRecorder(task_id, config=self.config)
        kwargs["register_new_step_callback"] = self._on_step
        kwargs["extend_system_message"] = build_system_prompt(kwargs.pop("extend_system_message","") or "",skill_extensions)
        kwargs["max_actions_per_step"] = 1
        kwargs.setdefault("llm_timeout",self.config.LLM_TIMEOUT)
        kwargs.setdefault("generate_gif",False)
        # 由模型理解完整任务后导航，避免原库把紧邻 URL 的中文说明拼入网址。
        kwargs.setdefault("directly_open_url",False)
        if kwargs.get("use_judge",True) and kwargs.get("judge_llm") is None:
            kwargs["judge_llm"] = build_judge_llm(self.config)
        super().__init__(task=task, browser_session=browser_session, tools=self.os_controller,
            llm=llm if llm is not None else build_llm(self.config), task_id=task_id, **kwargs)
        # 锁定原库按 DeepSeek 名称一律关闭视觉；仅恢复已支持图片的 Flash。
        if supports_deepseek_vision(self.llm):
            self.settings.use_vision = kwargs.get("use_vision", True)
            if self.settings.use_vision:
                self.logger.info("已为 DeepSeek Flash 恢复图片输入")
        if (self.settings.use_judge and self.settings.use_vision
                and self.judge_llm.provider == "deepseek" and not supports_deepseek_vision(self.judge_llm)):
            raise ValueError("视觉开启时 Judge 必须支持图片，请选择 DeepSeek Flash 或显式关闭 use_vision")

    def _set_screenshot_service(self):
        self.screenshot_service = self.recorder

    def _extend_outputs(self):
        self.AgentOutput = extend_output_model(self.AgentOutput)
        self.DoneAgentOutput = extend_output_model(self.DoneAgentOutput)

    def _setup_action_models(self):
        super()._setup_action_models()
        self._extend_outputs()

    async def _update_action_models_for_page(self, page_url):
        await super()._update_action_models_for_page(page_url)
        self._extend_outputs()

    async def _on_step(self, state_summary, model_output, step_num):
        self.audit.raise_if_failed()
        self.audit.step_number = step_num
        actions = getattr(model_output, "action", [])
        # 控制动作直接处理；以实际动作判断，不能依赖模型填写的节奏标签。
        action_names = {name for action in actions for name in action.model_dump(exclude_none=True)}
        if action_names - {"done", "request_takeover"}:
            rhythm = self.orchestrator.rhythm if self.orchestrator is not None else self.rhythm
            await rhythm.consume_read_time(
                getattr(model_output, "read_time_ms", None),
                action_type=getattr(model_output, "action_type", None),
            )
        if self._user_step_callback is not None:
            result = self._user_step_callback(state_summary,model_output,step_num)
            if inspect.isawaitable(result):
                await result

    async def _finalize(self, browser_state_summary):
        await super()._finalize(browser_state_summary)
        await maybe_save_history(self.history,self.task_id,len(self.history.history),
            config=self.config,sensitive_data=self.sensitive_data)

    async def step(self, step_info=None):
        # 原生 step/multi_act 会把工具异常转成普通失败；审计故障须在其外层退出。
        self.audit.raise_if_failed()
        await super().step(step_info)
        self.audit.raise_if_failed()

    async def _verify_resume(self) -> ResumeCheck:
        """只读获取新原生页面上下文，用同一主模型复核，不改写决策历史。"""
        try:
            self.browser_session.cdp_client
        except AssertionError as error:
            raise ResumeFatalError("浏览器连接已关闭，无法恢复任务") from error
        deadline = asyncio.timeout(self.settings.llm_timeout)
        async with deadline:
            try:
                state = await self.browser_session.get_browser_state_summary(
                    cached=False, include_screenshot=self.settings.use_vision,
                )
            except Exception as error:
                if self._is_connection_like_error(error):
                    raise ResumeFatalError("浏览器连接不可用，无法恢复任务") from error
                raise
            if state.state_error:
                raise RuntimeError("当前页面上下文获取失败，无法进行恢复复核")
            message = AgentMessagePrompt(
                browser_state_summary=state, file_system=self.file_system, task=self.task,
                include_attributes=self.settings.include_attributes,
                read_state_description=f"用户声明已完成处理；原接管原因：{self.takeover.snapshot.takeover_reason}",
                screenshots=[state.screenshot] if state.screenshot and self.settings.use_vision else [],
                llm_screenshot_size=self.browser_session.llm_screenshot_size,
            ).get_user_message(use_vision=self.settings.use_vision)
            message = self._message_manager._filter_sensitive_data(message)
            result = await self.llm.ainvoke(
                [SystemMessage(content=RESUME_CHECK_PROTOCOL), message], output_format=ResumeCheck,
            )
        if deadline.expired():
            raise TimeoutError("恢复复核超时")
        return ResumeCheck.model_validate(result.completion)

    async def resume_task(self):
        """宿主声明已处理完成；等待本次复核与授权的实际结果。"""
        if self._run_task is None or self._run_task.done() or asyncio.current_task() is self._run_task:
            raise ResumeConflictError("当前任务不能接收恢复请求")
        return await self.takeover.request_resume()

    async def _prepare_resume(self):
        """恢复前显式切回原任务页，丢弃旧索引并确认可以重新感知。"""
        async with asyncio.timeout(self.config.PAGE_LOAD_TIMEOUT):
            await self.os_controller.restore_task_page(self.browser_session)
            state = await self.browser_session.get_browser_state_summary(
                cached=False, include_screenshot=self.settings.use_vision,
            )
            if state.state_error:
                raise RuntimeError("原任务页面上下文获取失败，暂不能恢复")
            await self.os_controller.confirm_task_page(self.browser_session)

    def cancel_task(self) -> None:
        """接受取消后立即撤销，取消终态在运行协程清理完成后发布。"""
        if self.takeover.snapshot.status in {"cancelling", "cancelled"}:
            return
        if self._run_task is None or self._run_task.done():
            raise ResumeConflictError("任务尚未运行或已结束")
        self.takeover.request_cancel()
        if not self._run_task.cancelling():
            self._run_task.cancel()

    async def run(self, max_steps=500, on_step_start=None, on_step_end=None):
        if self._has_run:
            raise RuntimeError("每次任务须创建新的 ShadowAgent 实例")
        self._has_run = True
        self.os_controller.bind_takeover(self.takeover)
        self._run_task = asyncio.current_task()

        async def step_end(agent):
            self.audit.raise_if_failed()
            if self.os_controller.takeover_error is not None:
                raise RuntimeError(self.os_controller.takeover_error)
            if on_step_end is not None:
                result = on_step_end(agent)
                if inspect.isawaitable(result):
                    await result
            was_waiting = self.takeover.snapshot.status == "awaiting_user"
            await self.takeover.wait_if_requested(
                self._verify_resume, self.os_controller.authorize, prepare=self._prepare_resume,
            )
            if was_waiting:
                self.state.last_result = [ActionResult(
                    long_term_memory="人工处理已完成，复核与桌面授权已通过，已切回原任务页面并刷新状态，任务已恢复；请基于新页面重新定位元素后继续原任务。",
                )]

        outcome, error_code, primary_error = "unknown", None, None
        try:
            self.takeover.bind(self.browser_session.event_bus)
            await self.audit.record("task_start")
            await self.os_controller.authorize()
            history = await super().run(max_steps=max_steps, on_step_start=on_step_start, on_step_end=step_end)
            self.audit.raise_if_failed()
            success = history.is_successful()
            outcome = "completed" if success is True else "failed" if success is False else "unknown"
            error_code = "task_failed" if outcome == "failed" else None
            return history
        except BaseException as error:
            primary_error = error
            cancelled = isinstance(error, asyncio.CancelledError)
            outcome, error_code = ("cancelled", "task_cancelled") if cancelled else ("failed", "task_failed")
            if cancelled:
                self.takeover.request_cancel()
            raise
        finally:
            try:
                await self._cleanup_run()
            except BaseException as error:
                if primary_error is None:
                    primary_error = error
                    outcome, error_code = (("cancelled", "task_cancelled")
                        if isinstance(error, asyncio.CancelledError) else ("failed", "task_failed"))
                    raise
            finally:
                try:
                    try:
                        await self.audit.drain()
                    except asyncio.CancelledError:
                        # 等待写入期间取消，也须在实际线程退出后尝试记录终态。
                        with suppress(AuditError):
                            await self.audit.record("task_end",
                                outcome="cancelled" if primary_error is None else outcome,
                                error_code="task_cancelled" if primary_error is None else error_code)
                        raise
                    await self.audit.record("task_end", outcome=outcome, error_code=error_code)
                except BaseException:
                    if primary_error is None:
                        raise
                finally:
                    self._run_task = None

    async def _cleanup_run(self):
        self.takeover.close()
        self.os_controller.unbind_takeover(self.takeover)
        self.os_controller.revoke()
        history_error = None
        try:
            await maybe_save_history(self.history,self.task_id,-1,config=self.config,sensitive_data=self.sensitive_data)
        except BaseException as error:
            history_error = error
            raise
        finally:
            try:
                try:
                    await self.recorder.finish_async()
                except BaseException:
                    # GIF 收尾错误不能覆盖此前的取消或历史保存异常。
                    if history_error is None:
                        raise
            finally:
                self.takeover.finish_cancel()
