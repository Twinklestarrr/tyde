const channelName = 'tyde-session-role';
const storageKey = 'tyde:session-role-sync';
const messageType = 'SESSION_ROLE_INVALIDATED';
let subscribedChannel: BroadcastChannel | undefined;

/** 只通知同源、同账号标签页重读会话，不广播角色或认证凭证。 */
export function broadcastWorkspaceRoleChange(accountId: string) {
  const message = { type: messageType, accountId };
  try {
    // 复用本标签的订阅对象发送，BroadcastChannel 才不会通知自己的订阅。
    const channel = subscribedChannel ?? new BroadcastChannel(channelName);
    try {
      channel.postMessage(message);
    } finally {
      if (channel !== subscribedChannel) channel.close();
    }
    return;
  } catch {
    // 频道不可用时使用瞬时 storage 事件；广播失败不影响已成功的角色切换。
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify(message));
    localStorage.removeItem(storageKey);
  } catch {
    // 隐私模式或存储禁用时，当前标签页仍以服务端结果为准。
  }
}

export function subscribeWorkspaceRoleChanges(accountId: string, listener: () => void) {
  function receive(value: unknown) {
    if (
      value &&
      typeof value === 'object' &&
      'type' in value &&
      value.type === messageType &&
      'accountId' in value &&
      value.accountId === accountId
    )
      listener();
  }
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(channelName);
    subscribedChannel = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => receive(event.data);
  } catch {
    // 与发送端共用浏览器原生 storage 事件回退。
  }
  function handleStorage(event: StorageEvent) {
    if (event.key !== storageKey || !event.newValue) return;
    try {
      if (event.storageArea !== localStorage) return;
      receive(JSON.parse(event.newValue));
    } catch {
      // 其他标签页的无效消息不改变当前会话。
    }
  }
  // 发送标签可能只有 postMessage 失败，接收方仍需接住它的 storage 回退。
  window.addEventListener('storage', handleStorage);
  return () => {
    if (subscribedChannel === channel) subscribedChannel = undefined;
    channel?.close();
    window.removeEventListener('storage', handleStorage);
  };
}
