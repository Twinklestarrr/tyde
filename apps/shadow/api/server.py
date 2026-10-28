"""本地任务提交与后台执行；复用原生 Agent，单任务占用桌面。"""

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import json
import logging
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse

from api.lifecycle import Lifecycle
from api.schemas import (CancelResponse, LLMConfigRequest, LLMConfigResponse, ProgressResponse,
                         ResumeResponse, TaskRequest, TaskResponse)
from auth.audit import AuditError, AuditLog
from auth.token import TokenAuth
from browser.session import create_session
from config.settings import Settings, settings

logger = logging.getLogger(__name__)
_DEBUG_PAGE_PATH = Path(__file__).resolve().parents[1] / "tests" / "web_debug" / "index.html"


@dataclass
class _TaskExecution:
    """仅保存宿主运行引用及轻量结果；决策、动作和历史仍由 Agent 管理。"""

    task_id: str
    account_id: str
    status: str = "accepted"
    message: str | None = None
    error_code: str | None = None
    steps_completed: int = 0
    current_url: str | None = None
    started: bool = False
    cancel_requested: bool = False
    finishing: bool = False
    cleanup_complete: bool = False
    launch_attempted: bool = False
    runner: asyncio.Task | None = field(default=None, repr=False)
    agent: Any = field(default=None, repr=False)
    session: Any = field(default=None, repr=False)
    browser_process: Any = field(default=None, repr=False)


def _build_agent(**kwargs):
    # 模型与桌面模块延迟到后台任务构造，API 启动不初始化这些组件。
    from agent.loop import ShadowAgent

    return ShadowAgent(**kwargs)


async def _wait_cleanup(work):
    """退出等待受到取消时，先等实际运行或清理结束，再传播取消。"""
    worker = asyncio.ensure_future(work)
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not worker.cancelled():
            worker.exception()
        raise


async def _close_session(record):
    if record.session is not None:
        watchdog = getattr(record.session, "_local_browser_watchdog", None)
        if record.browser_process is None and watchdog is not None:
            # 原库 kill 会丢弃进程对象，须在调用前保留本任务的退出核验依据。
            record.browser_process = watchdog._subprocess
        await record.session.kill()
        process = record.browser_process
        if process is not None:
            try:
                alive = process.is_running() and process.status() not in {"zombie", "dead"}
            except Exception:
                # 查询期间进程可能刚好退出；仍存活或无法确认时保留占用。
                if process.is_running():
                    raise RuntimeError("无法确认浏览器进程已退出") from None
                alive = False
            if alive:
                raise RuntimeError("无法确认浏览器进程已退出")
        elif record.launch_attempted:
            raise RuntimeError("无法确认浏览器进程已退出")
    record.cleanup_complete = True


def _release_execution(app, record):
    record.agent = record.runner = None
    if record.cleanup_complete:
        record.session = record.browser_process = None
        if app.state.active_task is record:
            app.state.active_task = None


def _request_stop(record):
    worker = record.runner
    if worker is None or worker.done():
        return
    record.cancel_requested = True
    record.status = "cancelling"
    if record.agent is not None:
        record.agent.os_controller.revoke()
        try:
            record.agent.cancel_task()
        except RuntimeError:
            # Agent 已进入收尾时，接管入口可能已经关闭。
            pass
    # 尚未开始的协程不会执行 finally，留给它启动后检查取消标志。
    if record.started and not worker.cancelling():
        worker.cancel()


def _update_progress(record, agent, *, step_finished=False):
    """只在运行钩子保存已有信息，不在 HTTP 查询中读取新页面。"""
    if step_finished:
        record.steps_completed = max(record.steps_completed, agent.state.n_steps - 1, 0)
    for item in reversed(agent.history.history):
        if item.state.url:
            record.current_url = item.state.url
            break


async def _execute_task(app, record, description, config):
    record.started = True
    agent_started, primary_error = False, False
    outcome, code, message = "failed", "task_failed", "任务执行失败"
    try:
        if record.cancel_requested:
            raise asyncio.CancelledError
        record.session = create_session(record.account_id)
        record.session.browser_profile.keep_alive = True
        bus = getattr(record.session, "event_bus", None)
        if bus is not None:
            from browser_use.browser.events import BrowserLaunchEvent

            async def observe_launch(event):
                record.launch_attempted = True

            bus.on(BrowserLaunchEvent, observe_launch)
        record.agent = _build_agent(task=description, browser_session=record.session,
            task_id=record.task_id, account_id=record.account_id, config=config, enable_signal_handler=False)
        record.status = "running"
        agent_started = True

        async def step_start(agent):
            _update_progress(record, agent)

        async def step_end(agent):
            _update_progress(record, agent, step_finished=True)

        history = await record.agent.run(on_step_start=step_start, on_step_end=step_end)
        if record.cancel_requested:
            outcome, code, message = "cancelled", "task_cancelled", "任务已取消"
        elif history.is_successful() is True:
            outcome, code, message = "completed", None, history.final_result()
        else:
            # 已返回到 API 的未完成结果，不能被后续会话收尾中的取消覆盖。
            primary_error = True
            code, message = "task_incomplete", "任务未完成"
    except asyncio.CancelledError:
        primary_error = True
        outcome, code, message = "cancelled", "task_cancelled", "任务已取消"
    except Exception:
        primary_error = True
        logger.error("任务 %s 执行失败", record.task_id)
    finally:
        record.finishing = True
        if record.agent is not None:
            _update_progress(record, record.agent)
        try:
            if not agent_started:
                async def record_unstarted():
                    audit = AuditLog(record.task_id, record.account_id)
                    await audit.record("task_start")
                    await audit.record("task_end", outcome=outcome, error_code=code)

                await _wait_cleanup(record_unstarted())
        except asyncio.CancelledError:
            if not primary_error:
                outcome, code, message = "cancelled", "task_cancelled", "任务已取消"
        except AuditError:
            logger.error("任务 %s 启动前审计失败", record.task_id)
        finally:
            try:
                # Agent 保留会话，API 关闭并核验本任务拥有的浏览器进程。
                await _wait_cleanup(_close_session(record))
            except asyncio.CancelledError:
                if not primary_error:
                    outcome, code, message = "cancelled", "task_cancelled", "任务已取消"
            except Exception:
                logger.error("任务 %s 会话清理失败", record.task_id)
            finally:
                if not record.cleanup_complete:
                    outcome, message = "failed", "会话清理失败，暂不接受新任务"
                    code = code or "cleanup_failed"
                record.status, record.error_code, record.message = outcome, code, message
                _release_execution(app, record)


def create_app(config: Settings | None = None) -> FastAPI:
    """构造应用；生成凭据和加锁等副作用延迟到实际启动时执行。"""
    # 前端凭据属于此应用实例，不能修改全局配置或调用方传入的对象。
    config = (config if config is not None else settings).model_copy(deep=True)
    if Path(config.PID_FILE_PATH).resolve() == Path(config.TOKEN_FILE_PATH).resolve():
        raise ValueError("PID 与 token 必须使用不同文件")
    lifecycle = Lifecycle(config.PID_FILE_PATH)
    token_auth = TokenAuth(config.TOKEN_FILE_PATH)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if not lifecycle.acquire():
            raise RuntimeError("已有 Agent 实例正在运行")
        try:
            token_auth.generate_and_save()
            app.state.accepting_tasks = True
            yield
        finally:
            app.state.accepting_tasks = False
            try:
                record = app.state.active_task
                if record is not None:
                    _request_stop(record)
                    try:
                        if record.runner is not None:
                            await _wait_cleanup(record.runner)
                    finally:
                        if not record.cleanup_complete:
                            try:
                                await _wait_cleanup(_close_session(record))
                            finally:
                                _release_execution(app, record)
            finally:
                config.LLM_API_KEY = ""
                token_auth.token = ""
                lifecycle.cleanup()

    app = FastAPI(title="shadow-agent", version="0.1.0", lifespan=lifespan)
    app.state.token_auth = token_auth
    app.state.accepting_tasks = False
    app.state.active_task = None
    app.state.task_results = {}

    @app.exception_handler(RequestValidationError)
    async def safe_config_validation(request: Request, error: RequestValidationError):
        if request.url.path == "/config/llm":
            # FastAPI 默认校验响应含 input，密钥接口必须使用固定提示。
            return JSONResponse(status_code=422, headers={"Cache-Control": "no-store"},
                content={"detail": "api_key 必须为非空字符串，且不能包含额外字段"})
        return await request_validation_exception_handler(request, error)

    @app.put("/config/llm", response_model=LLMConfigResponse,
        dependencies=[Depends(token_auth.verify)], summary="配置当前服务内存中的模型密钥",
        responses={409: {"description": "任务仍在运行或清理"}, 503: {"description": "服务未就绪"}})
    async def configure_llm(request: LLMConfigRequest):
        if not app.state.accepting_tasks:
            raise HTTPException(status_code=503, detail="服务尚未启动或正在退出")
        if app.state.active_task is not None:
            raise HTTPException(status_code=409, detail="任务运行或清理期间不能更换模型密钥")
        config.LLM_API_KEY = request.api_key.get_secret_value()
        return JSONResponse(content={"configured": True}, headers={"Cache-Control": "no-store"})

    @app.get("/version", summary="查询 Agent 版本")
    async def get_version():
        return {"version": app.version}

    @app.get("/debug", include_in_schema=False)
    async def get_debug_page():
        # 本地页面整体忽略；缺失时不影响正常接口，也不注入访问凭据。
        if not _DEBUG_PAGE_PATH.is_file():
            raise HTTPException(status_code=404, detail="本地调试页面不存在")
        return FileResponse(_DEBUG_PAGE_PATH, media_type="text/html", headers={"Cache-Control": "no-store"})

    @app.post(
        "/task",
        response_model=TaskResponse,
        status_code=202,
        dependencies=[Depends(token_auth.verify)],
        summary="提交任务并后台执行",
        responses={409: {"description": "桌面任务正在运行或清理"}, 503: {"description": "服务正在退出"}},
    )
    async def create_task(request: TaskRequest):
        if not app.state.accepting_tasks:
            raise HTTPException(status_code=503, detail="服务尚未启动或正在退出")
        if app.state.active_task is not None:
            raise HTTPException(status_code=409, detail="已有桌面任务正在运行或清理")
        if not config.LLM_API_KEY.strip():
            raise HTTPException(status_code=503, detail="请先配置模型 API Key")
        description = request.params["task"].strip()
        supplement = {key: value for key, value in request.params.items() if key != "task"}
        if supplement:
            description += "\n\n补充参数（JSON）：\n" + json.dumps(supplement, ensure_ascii=False)
        record = _TaskExecution(task_id=str(uuid4()), account_id=request.account_id)
        # 从检查名额到登记运行引用之间不让出协程，避免并发提交同时受理。
        app.state.active_task = record
        app.state.task_results[record.task_id] = record
        work = _execute_task(app, record, description, config)
        try:
            record.runner = asyncio.create_task(work)
        except Exception:
            work.close()
            app.state.active_task = None
            app.state.task_results.pop(record.task_id)
            raise HTTPException(status_code=503, detail="任务暂时无法受理") from None
        return TaskResponse(task_id=record.task_id, status="accepted")

    @app.get(
        "/task/{task_id}/status",
        response_model=ProgressResponse,
        dependencies=[Depends(token_auth.verify)],
        summary="只读查询任务状态与进度",
        responses={404: {"description": "任务不存在"}},
    )
    async def get_status(task_id: str):
        record = app.state.task_results.get(task_id)
        if record is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        response = ProgressResponse(task_id=record.task_id, status=record.status,
            steps_completed=record.steps_completed, current_url=record.current_url, message=record.message)
        # API 终态及显式取消优先，旧等待快照不能重新拉起宿主弹窗。
        if record.status not in {"completed", "failed", "cancelled"}:
            if record.cancel_requested or record.status == "cancelling":
                response.status, response.message = "cancelling", "正在取消任务"
            elif record.agent is not None:
                snapshot = record.agent.takeover.snapshot
                if snapshot.status in {"cancelling", "cancelled"}:
                    response.status, response.message = "cancelling", "正在取消任务"
                elif snapshot.status == "awaiting_user" and not record.finishing:
                    response.status = snapshot.status
                    response.message = snapshot.message
                    response.takeover_reason = snapshot.takeover_reason
                    response.login_required = snapshot.login_required
                    response.captcha_detected = snapshot.captcha_detected
        return response

    @app.post(
        "/task/{task_id}/resume",
        response_model=ResumeResponse,
        response_model_exclude_none=True,
        dependencies=[Depends(token_auth.verify)],
        summary="验证人工处理结果并恢复原任务",
        responses={404: {"description": "任务不存在"}, 409: {"description": "任务当前不能恢复"},
            502: {"description": "恢复复核失败"}, 503: {"description": "任务已无法恢复"},
            504: {"description": "恢复复核超时"}},
    )
    async def resume_task(task_id: str, request: Request):
        from core.orchestrator.takeover import ResumeConflictError, ResumeFatalError

        record = app.state.task_results.get(task_id)
        if record is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        if (record.status != "running" or record.cancel_requested or record.finishing
                or record.agent is None or record.runner is None or record.runner.done()
                or record.agent.takeover.snapshot.status != "awaiting_user"):
            raise HTTPException(status_code=409, detail="任务当前不能恢复")

        async def wait_disconnect():
            while (await request.receive())["type"] != "http.disconnect":
                pass
            # 在观察到断开的这一刻使请求失效，不能等外层调度后再取消。
            if not work.done():
                work.cancel()
                return True
            return False

        # 单独跟踪本次复核；连接中止不能连带取消原任务运行协程。
        work = asyncio.create_task(record.agent.resume_task())
        disconnected = asyncio.create_task(wait_disconnect())
        try:
            done, _ = await asyncio.wait({work, disconnected}, return_when=asyncio.FIRST_COMPLETED)
            if disconnected in done and disconnected.result():
                raise HTTPException(status_code=499, detail="恢复请求已断开")
            result = await work
            # 本次恢复成功不因后续业务快速收尾而失效，真正取消仍优先。
            if record.cancel_requested or record.status in {"cancelling", "cancelled"}:
                raise ResumeConflictError("任务正在取消，不能恢复")
            return ResumeResponse(resumed=result.resumed, message=result.message)
        except ResumeConflictError:
            raise HTTPException(status_code=409, detail="任务当前不能恢复或已有恢复请求正在处理") from None
        except TimeoutError:
            raise HTTPException(status_code=504, detail="恢复复核超时，请重试") from None
        except (ResumeFatalError, AuditError):
            raise HTTPException(status_code=503, detail="任务已无法恢复，正在结束") from None
        except HTTPException:
            raise
        except Exception:
            logger.error("任务 %s 恢复复核失败", task_id)
            raise HTTPException(status_code=502, detail="恢复复核失败，请稍后重试") from None
        finally:
            for worker in (work, disconnected):
                if not worker.done() and not worker.cancelling():
                    worker.cancel()
            await _wait_cleanup(asyncio.gather(work, disconnected, return_exceptions=True))

    @app.post(
        "/task/{task_id}/cancel",
        response_model=CancelResponse,
        status_code=202,
        dependencies=[Depends(token_auth.verify)],
        summary="请求取消任务，等待后台清理",
        responses={404: {"description": "任务不存在"}, 409: {"description": "任务已经结束"}},
    )
    async def cancel_task(task_id: str):
        record = app.state.task_results.get(task_id)
        if record is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        if (record.status in {"completed", "failed", "cancelled"}
                or record.runner is None or record.runner.done()):
            raise HTTPException(status_code=409, detail="任务已经结束，不能取消")
        # 受理到设置标志之间不让出协程，重复指令不再次打断运行或清理。
        if not record.cancel_requested:
            _request_stop(record)
        return CancelResponse(task_id=record.task_id, status="cancelling")

    return app


app = create_app()
