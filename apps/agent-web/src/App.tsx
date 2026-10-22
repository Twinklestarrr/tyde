import { useEffect, useState } from 'react';
import { ChatInput } from './components/ChatInput';
import { MarkdownBody } from './components/MarkdownBody';
import { getAgentHealth } from './services/agent-client';

type HealthState =
  { status: 'checking' } | { status: 'online' } | { status: 'offline'; message: string };

const FOUNDATION_NOTES = `**对话功能准备中。** 你可以先写下需求，保留为本页草稿。

- 服务状态仅表示当前连接情况。
- 对话开放后，可以在这里发送需求、查看回答与处理进展。
- 现在的草稿不会发送或保存到服务器。`;

export function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'checking' });
  const [checkId, setCheckId] = useState(0);
  const [draft, setDraft] = useState('');
  const [dark, setDark] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Agent 服务检查超时')), 5000);
    setHealth({ status: 'checking' });
    getAgentHealth({ signal: controller.signal })
      .then(() => {
        if (active) setHealth({ status: 'online' });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setHealth({
          status: 'offline',
          message: error instanceof Error ? error.message : '无法连接 Agent 服务',
        });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [checkId]);

  const healthLabel =
    health.status === 'checking'
      ? '正在检查服务'
      : health.status === 'online'
        ? 'Agent 服务已连接'
        : 'Agent 服务未连接';

  return (
    <div className="agent-shell" data-theme={dark ? 'dark' : 'mist'}>
      <aside className="agent-sidebar" aria-label="Agent 导航">
        <a className="brand" href="#">
          tyde<span>Agent</span>
        </a>
        <div className="sidebar-section">会话</div>
        <p className="sidebar-empty">对话接口接通后，会话将在这里展示。</p>
        <div className="sidebar-footer">你的协作空间</div>
      </aside>
      <main className="agent-main">
        <header className="agent-header">
          <div>
            <span className="eyebrow">TYDE WORKSPACE</span>
            <h1>Agent 工作区</h1>
          </div>
          <button className="quiet-button" onClick={() => setDark((value) => !value)}>
            {dark ? '浅色模式' : '深色模式'}
          </button>
        </header>
        <div className="conversation-area">
          <section className="setup-panel" aria-labelledby="setup-title">
            <div className="setup-symbol" aria-hidden="true">
              π
            </div>
            <span className="eyebrow">准备开始</span>
            <h2 id="setup-title">从这里开始协作</h2>
            <MarkdownBody>{FOUNDATION_NOTES}</MarkdownBody>
            <div className="connection-card">
              <div role="status" aria-live="polite">
                <span className={`status-dot ${health.status}`} aria-hidden="true" />
                <strong>{healthLabel}</strong>
                {health.status === 'offline' && <p>{health.message}</p>}
              </div>
              <button
                className="quiet-button"
                disabled={health.status === 'checking'}
                onClick={() => setCheckId((value) => value + 1)}
              >
                重新检查
              </button>
            </div>
          </section>
        </div>
        <footer className="composer-area">
          <ChatInput
            value={draft}
            onChange={setDraft}
            unavailableReason="对话接口尚未接入，草稿暂不可发送"
          />
          <p className="composer-hint">草稿仅保留在本页面内存中，刷新后清空。</p>
        </footer>
      </main>
    </div>
  );
}
