import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const hostFingerprint = createHash('sha256').update(hostname()).digest('hex').slice(0, 16);
const startupOwner = `local:${hostFingerprint}:${process.pid}:${randomUUID()}`;

/** One random identity for this process startup. Never reuse it across process launches. */
export function localExecutionOwner(): string {
  return startupOwner;
}

export interface LocalProcessOwner {
  hostFingerprint: string;
  pid: number;
  startupId: string;
}
export function parseLocalProcessOwner(ownerId: string): LocalProcessOwner | null {
  const match =
    /^local:([0-9a-f]{16}):([1-9][0-9]*):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
      ownerId,
    );
  if (!match) return null;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) return null;
  return { hostFingerprint: match[1]!, pid, startupId: match[3]! };
}

/**
 * Narrow single-host isolation proof. Lock loss, heartbeat expiry and remote hosts are
 * deliberately insufficient. EPERM or an existing/reused PID leaves recovery blocked.
 */
export function assertLocalProcessExited(ownerId: string): LocalProcessOwner {
  const owner = parseLocalProcessOwner(ownerId);
  if (!owner || owner.hostFingerprint !== hostFingerprint)
    throw new Error('AGENT_PROCESS_ISOLATION_NOT_LOCAL');
  try {
    process.kill(owner.pid, 0);
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ESRCH')
      return owner;
    throw new Error('AGENT_PROCESS_ISOLATION_UNCONFIRMED', { cause });
  }
  throw new Error('AGENT_PROCESS_STILL_EXISTS');
}
