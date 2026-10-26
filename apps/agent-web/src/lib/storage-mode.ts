import type { AgentStorageMode } from '../services/agent-client';

export function storageModeCopy(mode: AgentStorageMode | null) {
  if (mode === 'postgres')
    return {
      label: 'PostgreSQL 持久模式',
      description: '服务重启后保留历史。刷新与重连只恢复展示，不会自动继续执行。',
      hint: 'PostgreSQL 持久模式 · 服务重启保留历史 · 关闭页面不会停止任务',
    };
  if (mode === 'memory')
    return {
      label: '开发内存模式',
      description: '同进程刷新和断线可恢复展示。服务重启后会清空历史。',
      hint: '开发内存模式 · 服务重启会清空历史 · 关闭页面不会停止任务',
    };
  return {
    label: '存储模式尚未确认',
    description: '连接后将读取服务端存储模式，再进入工作区。',
    hint: '存储模式尚未确认',
  };
}
