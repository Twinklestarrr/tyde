import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { validateAgentContract } from '@tyde/shared/agent';
import { ChatInput } from './components/ChatInput';
import { MarkdownBody } from './components/MarkdownBody';
import { AttemptStats } from './components/AttemptStats';
import { MessageTime } from './components/MessageTime';
import { messageText } from './agent-events/projection';
import { AgentClient } from './services/agent-client';
import { ChatController } from './services/chat-controller';
import { taskExecutionPhase, type TaskExecutionPhase } from './lib/task-state';
import { storageModeCopy } from './lib/storage-mode';
import { useLocalCalendarDay } from './hooks/useLocalCalendarDay';

const TASK_LABELS: Record<TaskExecutionPhase, string> = {
  queued: '等待执行',
  running: '正在生成',
  waiting_input: '等待补充',
  stopping: '停止中',
  stopped: '已停止',
  interrupted: '执行中断',
  failed: '执行失败',
  completed: '已完成',
  budget_closing: '达到执行限制，正在收尾',
};

function requestedConversation(): string | null {
  const id = new URLSearchParams(window.location.hash.slice(1)).get('conversation');
  return validateAgentContract('UUID', id) ? id.toLowerCase() : null;
}

export function App() {
  const [credential, setCredential] = useState('');
  const [controller, setController] = useState<ChatController | null>(null);
  const [dark, setDark] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  useEffect(() => () => controller?.dispose(), [controller]);

  const connect = async () => {
    if (!credential.trim() || connecting) return;
    setConnecting(true);
    setConnectError(null);
    const next = new ChatController(new AgentClient(credential.trim()));
    const confirmed = await next.refreshStorageMode();
    setConnecting(false);
    if (!confirmed) {
      setConnectError(next.getSnapshot().error);
      next.dispose();
      return;
    }
    setCredential('');
    setController(next);
    void next.refreshList().then(() => {
      const selected =
        requestedConversation() ?? next.getSnapshot().conversations[0]?.conversation.id;
      if (selected) void next.select(selected);
    });
  };

  return (
    <div className="agent-shell" data-theme={dark ? 'dark' : 'light'}>
      {controller ? (
        <Workspace
          controller={controller}
          dark={dark}
          onTheme={() => setDark((value) => !value)}
          onDisconnect={() => setController(null)}
        />
      ) : (
        <main className="identity-page">
          <a className="brand" href="#">
            tyde<span>Agent</span>
          </a>
          <section className="setup-panel identity-card">
            <div className="setup-symbol" aria-hidden="true">
              π
            </div>
            <span className="eyebrow">存储模式尚未确认</span>
            <h1>连接你的 Agent 工作区</h1>
            <p>
              使用本机 Agent 服务配置的开发身份凭据连接。凭据只留在本页内存中，刷新后需要重新输入。
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void connect();
              }}
            >
              <label htmlFor="agent-credential">Agent 开发身份凭据</label>
              <input
                id="agent-credential"
                type="password"
                autoComplete="off"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                placeholder="输入服务端配置的 Bearer 凭据"
                required
              />
              <button
                className="primary-button"
                type="submit"
                disabled={!credential.trim() || connecting}
              >
                {connecting ? '正在确认存储模式…' : '连接工作区'}
              </button>
            </form>
            {connectError && (
              <p role="alert" className="mode-note">
                {connectError}
              </p>
            )}
            <p className="mode-note">连接后读取服务端存储模式。模型由服务端配置。</p>
          </section>
        </main>
      )}
    </div>
  );
}

function Workspace({
  controller,
  dark,
  onTheme,
  onDisconnect,
}: {
  controller: ChatController;
  dark: boolean;
  onTheme(): void;
  onDisconnect(): void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const calendarDay = useLocalCalendarDay();
  const storage = storageModeCopy(state.storageMode);
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const endRef = useRef<HTMLDivElement>(null);
  const { view, pending } = state;
  const task = view?.focusTask;
  const executionPhase = taskExecutionPhase(task);
  const budgetClosing = executionPhase === 'budget_closing';
  const canStart = !task || task.status === 'completed';
  const connectionLabel = {
    idle: '选择或新建会话',
    loading: '正在读取历史',
    connecting: '正在连接事件',
    connected: '实时连接',
    offline: '连接已断开',
    blocked: '连接暂停',
  }[state.connection];

  useEffect(() => {
    if (!state.selectedId) return;
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#conversation=${state.selectedId}`,
    );
    setDraft('');
  }, [state.selectedId]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [view?.messages, view?.overlays, task?.status]);

  const send = () => {
    const text = draft;
    const conversationId = state.selectedId;
    void controller.send(text).then((applied) => {
      if (
        applied &&
        draftRef.current === text &&
        controller.getSnapshot().selectedId === conversationId
      )
        setDraft('');
    });
  };
  const unavailableReason = pending
    ? pending.status === 'submitting'
      ? '正在提交并核实请求…'
      : '原请求结果未确认，请先核实'
    : !view
      ? '先选择或新建会话'
      : !canStart
        ? task?.active_attempt_id
          ? budgetClosing
            ? '达到执行限制，正在收尾'
            : '当前任务执行期间不能发送新目标'
          : '此目标尚未完成；继续和重试将在后续开放，可新建会话'
        : state.connection !== 'connected'
          ? '等待实时连接后发送'
          : undefined;

  return (
    <>
      <aside className="agent-sidebar" aria-label="Agent 会话">
        <a className="brand" href="#">
          tyde<span>Agent</span>
        </a>
        <button
          className="primary-button new-conversation"
          onClick={() => void controller.create()}
          disabled={state.creating}
        >
          {state.creating ? '正在创建…' : '＋ 新建会话'}
        </button>
        <div className="sidebar-heading">
          <span>会话</span>
          <button
            className="text-button"
            onClick={() => void controller.refreshList()}
            disabled={state.listLoading}
          >
            刷新
          </button>
        </div>
        <nav className="conversation-list">
          {state.conversations.map(({ conversation }) => (
            <button
              key={conversation.id}
              className={`conversation-button ${state.selectedId === conversation.id ? 'selected' : ''}`}
              onClick={() => void controller.select(conversation.id)}
              title={conversation.title}
            >
              <span>{conversation.title || '新会话'}</span>
              <small>
                {new Date(conversation.activity.last_activity_at).toLocaleString('zh-CN', {
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </small>
            </button>
          ))}
          {!state.conversations.length && (
            <p className="sidebar-empty">
              {state.listLoading ? '正在读取会话…' : '还没有会话，开始一段对话。'}
            </p>
          )}
        </nav>
        {state.listCursor && (
          <button
            className="text-button"
            disabled={state.listLoading}
            onClick={() => void controller.refreshList(true)}
          >
            更多会话
          </button>
        )}
        <div className="sidebar-footer">
          <strong>{storage.label}</strong>
          <p>{storage.description}</p>
          <button className="text-button" onClick={onDisconnect}>
            重新连接身份
          </button>
        </div>
      </aside>
      <main className="agent-main">
        <header className="agent-header">
          <div>
            <span className="eyebrow">TYDE AGENT · {storage.label}</span>
            <h1>{view?.conversation.title || 'Agent 工作区'}</h1>
          </div>
          <div className="header-actions">
            <button
              className="quiet-button mobile-new"
              onClick={() => void controller.create()}
              disabled={state.creating}
            >
              新建会话
            </button>
            <button className="quiet-button" onClick={onTheme}>
              {dark ? '浅色' : '深色'}
            </button>
            <button className="quiet-button mobile-identity" onClick={onDisconnect}>
              身份
            </button>
          </div>
        </header>
        <div className="stream-status" role="status">
          <span
            className={`status-dot ${state.connection === 'connected' ? 'online' : state.connection === 'offline' || state.connection === 'blocked' ? 'offline' : 'checking'}`}
          />
          {connectionLabel}
          {task && (
            <span className={`task-status task-${executionPhase}`}>
              {TASK_LABELS[executionPhase!]}
            </span>
          )}
          {state.selectedId && ['offline', 'blocked'].includes(state.connection) && (
            <button
              className="text-button"
              onClick={() => void controller.select(state.selectedId!)}
            >
              重新连接
            </button>
          )}
        </div>
        <div className="mobile-session-picker">
          <label htmlFor="mobile-session">当前会话</label>
          <select
            id="mobile-session"
            value={state.selectedId ?? ''}
            onChange={(event) => {
              if (event.target.value) void controller.select(event.target.value);
            }}
          >
            <option value="">选择会话</option>
            {state.conversations.map(({ conversation }) => (
              <option value={conversation.id} key={conversation.id}>
                {conversation.title || '新会话'}
              </option>
            ))}
          </select>
        </div>
        {state.error && (
          <div className="error-banner" role="alert">
            {state.error}
          </div>
        )}
        {pending?.status === 'unknown' && (
          <div className="pending-banner">
            <strong>
              {pending.command.kind === 'stop_attempt' ? '停止未确认' : '发送结果未确认'}
            </strong>
            <p>核实或原样重发将始终使用原 request_key、正文与目标，不会生成新意图。</p>
            <button className="quiet-button" onClick={() => void controller.verifyPending()}>
              核实原请求
            </button>
            <button className="quiet-button" onClick={() => void controller.resendPending()}>
              原样重发
            </button>
          </div>
        )}
        <div className={`conversation-area ${view ? 'has-conversation' : ''}`}>
          {!view ? (
            <section className="setup-panel">
              <div className="setup-symbol" aria-hidden="true">
                π
              </div>
              <h2>{state.connection === 'loading' ? '正在恢复会话' : '从一个问题开始'}</h2>
              <p>新建会话后自由输入，回答完成后可以继续追问。</p>
              <p className="mode-note">
                停止、失败和完成会分别显示。切换会话或断开订阅只改变展示，任务仍由服务端管理。
              </p>
              <div className="mobile-conversations">
                {state.conversations.map(({ conversation }) => (
                  <button
                    className="quiet-button"
                    key={conversation.id}
                    onClick={() => void controller.select(conversation.id)}
                  >
                    {conversation.title}
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <section className="message-list" aria-label="聊天历史">
              {view.page.has_more && (
                <button
                  className="quiet-button history-button"
                  disabled={state.historyLoading}
                  onClick={() => void controller.history()}
                >
                  {state.historyLoading ? '正在读取…' : '加载更早消息'}
                </button>
              )}
              {view.messages.size === 0 && (
                <div className="empty-conversation">
                  <h2>有什么想一起完成？</h2>
                  <p>直接输入问题，开始真实对话。</p>
                </div>
              )}
              {[...view.messages.values()]
                .sort((a, b) => (BigInt(a.message_seq) < BigInt(b.message_seq) ? -1 : 1))
                .map((message) => {
                  const text = messageText(view, message);
                  return (
                    <article
                      className={`chat-message message-${message.message_type}`}
                      key={message.id}
                    >
                      <div className="message-author">
                        {message.message_type === 'user_input'
                          ? '你'
                          : message.message_type === 'notice'
                            ? '提示'
                            : 'tyde Agent'}
                        <span>
                          {message.status === 'in_progress'
                            ? '生成中'
                            : message.status === 'interrupted'
                              ? '输出已中断'
                              : ''}
                        </span>
                      </div>
                      {text ? (
                        <MarkdownBody>{text}</MarkdownBody>
                      ) : (
                        <p className="generating-text">
                          {message.status === 'in_progress' ? '仍在生成…' : '此条输出没有正文。'}
                        </p>
                      )}
                      <MessageTime timestamp={message.created_at} calendarDay={calendarDay} />
                    </article>
                  );
                })}
              {task?.latest_attempt.error && (
                <div className="attempt-error">
                  <strong>{TASK_LABELS[task.status]}</strong>
                  <p>{task.latest_attempt.error.summary}</p>
                  <small>{task.latest_attempt.error.code}</small>
                </div>
              )}
              {view.operations.size > 0 && (
                <details className="operation-list">
                  <summary>操作过程（{view.operations.size}）</summary>
                  {[...view.operations.values()].map((operation) => (
                    <div className="operation-card" key={operation.id}>
                      <strong>{operation.operation_kind}</strong>
                      <span>{operation.confirmation_state}</span>
                      <p>{operation.summary}</p>
                    </div>
                  ))}
                </details>
              )}
              {task && <AttemptStats key={task.latest_attempt.id} attempt={task.latest_attempt} />}
              <div ref={endRef} />
            </section>
          )}
        </div>
        <footer className="composer-area">
          {task?.active_attempt_id && (
            <div className="stop-row">
              <span>
                {budgetClosing
                  ? '达到执行限制，正在收尾'
                  : task.status === 'stopping'
                    ? '停止请求已受理，正在等待执行实际结束。'
                    : TASK_LABELS[task.status]}
              </span>
              <button
                className="stop-button"
                disabled={budgetClosing || task.status === 'stopping' || Boolean(pending)}
                onClick={() => void controller.stop()}
              >
                {budgetClosing ? '正在收尾…' : task.status === 'stopping' ? '停止中…' : '停止生成'}
              </button>
            </div>
          )}
          <ChatInput
            value={draft}
            onChange={setDraft}
            onSend={send}
            unavailableReason={unavailableReason}
          />
          <p className="composer-hint">{storage.hint}</p>
        </footer>
      </main>
    </>
  );
}
