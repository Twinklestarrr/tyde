import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  PI_NATIVE_FORMAT_VERSION,
  PI_RUNTIME_VERSION,
  PI_SDK_VERSION,
  validatePiNativeState,
  type PiNativeState,
} from '../pi/native-state.js';
import { digest } from './projections.js';

export interface ExecutionAuthority {
  conversationId: string;
  taskId: string;
  piSessionId: string;
  attemptId: string;
  ownerId: string;
  generation: string;
  expectedHeadRevisionId: string;
}
export interface NativeCommit<Effects = unknown> {
  key: string;
  hash: string;
  authority: Readonly<ExecutionAuthority>;
  state: Readonly<PiNativeState>;
  reason: string;
  effects: Effects;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
function semanticBody(request: Omit<NativeCommit, 'key' | 'hash'>) {
  return {
    authority: request.authority,
    state: request.state,
    reason: request.reason,
    effects: request.effects,
  };
}
export function freezeCommit(
  authority: ExecutionAuthority,
  state: PiNativeState,
  reason: string,
): NativeCommit<null>;
export function freezeCommit<Effects>(
  authority: ExecutionAuthority,
  state: PiNativeState,
  reason: string,
  effects: Effects,
): NativeCommit<Effects>;
export function freezeCommit(
  authority: ExecutionAuthority,
  state: PiNativeState,
  reason: string,
  effects: unknown = null,
): NativeCommit {
  validatePiNativeState(state);
  const data = structuredClone({ authority, state, reason, effects });
  return deepFreeze({ key: randomUUID(), hash: digest(data), ...data });
}

export class NativeCommitOutcomeUnknownError extends Error {
  readonly code = 'PI_COMMIT_OUTCOME_UNKNOWN';
  constructor(
    readonly piSessionId: string,
    readonly commitKey: string,
    readonly commitHash: string,
  ) {
    super('PI_COMMIT_OUTCOME_UNKNOWN');
  }
}

/** PostgreSQL revisions are the sole native recovery source. No product text reconstruction. */
export class NativeStore {
  constructor(
    private readonly pool: Pool,
    private readonly failClosed: () => void,
  ) {}

  async load(
    piSessionId: string,
    revisionId?: string,
  ): Promise<{ revisionId: string; state: PiNativeState }> {
    const client = await this.pool.connect().catch((error: unknown) => {
      this.failClosed();
      throw error;
    });
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const {
        rows: [revision],
      } = await client.query(
        `SELECT r.*, s.runtime_manifest
         FROM pi_sessions p JOIN pi_session_revisions r ON r.pi_session_id=p.id
           AND r.id=COALESCE($2::uuid,p.head_revision_id)
         LEFT JOIN agent_execution_snapshots s ON s.id=r.execution_snapshot_id
         WHERE p.id=$1`,
        [piSessionId, revisionId ?? null],
      );
      if (!revision) throw new Error('PI_REVISION_MISSING');
      const { rows } = await client.query(
        'SELECT entry_seq,raw_entry FROM pi_session_entries WHERE pi_session_id=$1 AND entry_seq<=$2 ORDER BY entry_seq',
        [piSessionId, revision.last_entry_seq],
      );
      if (
        BigInt(rows.length) !== BigInt(revision.last_entry_seq) ||
        rows.some((entry, index) => BigInt(entry.entry_seq) !== BigInt(index + 1))
      )
        throw new Error('PI_ENTRY_SEQUENCE_GAP');
      // R0 predates an execution snapshot. Every later revision uses its frozen runtime identity.
      const runtimeVersion =
        revision.revision_no === '0'
          ? PI_RUNTIME_VERSION
          : revision.runtime_manifest?.runtime_version;
      const state: unknown = {
        header: revision.raw_header,
        entries: rows.map((entry) => entry.raw_entry),
        leafId: revision.active_leaf_entry_id,
        sdkVersion: revision.sdk_version,
        nativeFormatVersion: revision.native_format_version,
        runtimeVersion,
      };
      validatePiNativeState(state);
      await client.query('COMMIT');
      return { revisionId: revision.id as string, state };
    } catch (error) {
      this.failClosed();
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Confirms only the original save; it never returns a dispatch permit or updates authority. */
  async lookup(piSessionId: string, key: string, hash: string): Promise<string | null> {
    try {
      const {
        rows: [revision],
      } = await this.pool.query(
        'SELECT id,commit_hash FROM pi_session_revisions WHERE pi_session_id=$1 AND commit_key=$2',
        [piSessionId, key],
      );
      if (!revision) return null;
      if (revision.commit_hash !== hash) throw new Error('PI_COMMIT_KEY_CONFLICT');
      return revision.id as string;
    } catch (error) {
      this.failClosed();
      throw error;
    }
  }

  async commit<Effects>(
    original: NativeCommit<Effects>,
    apply?: (client: PoolClient, revisionId: string, effects: Effects) => Promise<void>,
  ): Promise<string> {
    // Freeze before connecting/awaiting. A caller cannot alter a retry while a transaction waits.
    const request = deepFreeze(structuredClone(original));
    validatePiNativeState(request.state);
    if (digest(semanticBody(request)) !== request.hash) throw new Error('PI_COMMIT_HASH_INVALID');
    const authority = request.authority;
    const client = await this.pool.connect().catch((error: unknown) => {
      this.failClosed();
      throw error;
    });
    let commitSent = false;
    let released = false;
    try {
      await client.query('BEGIN');
      const {
        rows: [conversation],
      } = await client.query('SELECT * FROM agent_conversations WHERE id=$1 FOR UPDATE', [
        authority.conversationId,
      ]);
      const {
        rows: [task],
      } = await client.query('SELECT * FROM agent_tasks WHERE id=$1 FOR UPDATE', [
        authority.taskId,
      ]);
      const {
        rows: [session],
      } = await client.query('SELECT * FROM pi_sessions WHERE id=$1 FOR UPDATE', [
        authority.piSessionId,
      ]);
      const {
        rows: [old],
      } = await client.query(
        'SELECT id,commit_hash FROM pi_session_revisions WHERE pi_session_id=$1 AND commit_key=$2',
        [authority.piSessionId, request.key],
      );
      if (old) {
        if (old.commit_hash !== request.hash) throw new Error('PI_COMMIT_KEY_CONFLICT');
        commitSent = true;
        await client.query('COMMIT');
        return old.id as string;
      }
      const {
        rows: [attempt],
      } = await client.query('SELECT * FROM agent_attempts WHERE id=$1 FOR UPDATE', [
        authority.attemptId,
      ]);
      if (
        !conversation ||
        conversation.deleted_at !== null ||
        conversation.pi_session_id !== authority.piSessionId ||
        !task ||
        task.conversation_id !== authority.conversationId ||
        task.pi_session_id !== authority.piSessionId ||
        !session ||
        session.conversation_id !== authority.conversationId ||
        session.writer_owner_id !== authority.ownerId ||
        session.execution_generation !== authority.generation ||
        session.active_attempt_id !== authority.attemptId ||
        session.head_revision_id !== authority.expectedHeadRevisionId ||
        !attempt ||
        attempt.task_id !== authority.taskId ||
        attempt.pi_session_id !== authority.piSessionId ||
        attempt.ended_at !== null ||
        attempt.execution_owner_id !== authority.ownerId ||
        attempt.execution_generation !== authority.generation
      )
        throw new Error('PI_EXECUTION_REVOKED');
      if (
        request.state.header.id !== session.native_session_id ||
        request.state.sdkVersion !== PI_SDK_VERSION ||
        request.state.nativeFormatVersion !== PI_NATIVE_FORMAT_VERSION
      )
        throw new Error('PI_NATIVE_IDENTITY_CHANGED');
      const {
        rows: [snapshot],
      } = await client.query('SELECT runtime_manifest FROM agent_execution_snapshots WHERE id=$1', [
        task.execution_snapshot_id,
      ]);
      if (
        snapshot?.runtime_manifest.sdk_version !== request.state.sdkVersion ||
        snapshot.runtime_manifest.runtime_version !== request.state.runtimeVersion
      )
        throw new Error('PI_NATIVE_RUNTIME_MISMATCH');
      const {
        rows: [head],
      } = await client.query(
        'SELECT * FROM pi_session_revisions WHERE id=$1 AND pi_session_id=$2',
        [session.head_revision_id, session.id],
      );
      if (!head) throw new Error('PI_REVISION_MISSING');
      const { rows: existing } = await client.query(
        'SELECT native_entry_id,raw_entry FROM pi_session_entries WHERE pi_session_id=$1 ORDER BY entry_seq',
        [session.id],
      );
      if (
        BigInt(existing.length) !== BigInt(head.last_entry_seq) ||
        request.state.entries.length < existing.length
      )
        throw new Error('PI_APPEND_ORDER_REGRESSION');
      for (let index = 0; index < existing.length; index++)
        if (digest(request.state.entries[index]) !== digest(existing[index].raw_entry))
          throw new Error('PI_IMMUTABLE_ENTRY_CHANGED');
      for (let index = existing.length; index < request.state.entries.length; index++) {
        const entry = request.state.entries[index]!;
        await client.query(
          `INSERT INTO pi_session_entries(pi_session_id,native_entry_id,parent_entry_id,entry_seq,entry_type,raw_entry,created_at)
           VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())`,
          [session.id, entry.id, entry.parentId, index + 1, entry.type, JSON.stringify(entry)],
        );
      }
      const revisionId = randomUUID();
      await client.query(
        `INSERT INTO pi_session_revisions(id,pi_session_id,revision_no,previous_revision_id,last_entry_seq,active_leaf_entry_id,raw_header,sdk_version,native_format_version,execution_snapshot_id,writer_attempt_id,writer_owner_id,execution_generation,commit_key,commit_schema_version,commit_hash,commit_reason,committed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,clock_timestamp())`,
        [
          revisionId,
          session.id,
          (BigInt(head.revision_no) + 1n).toString(),
          head.id,
          request.state.entries.length,
          request.state.leafId,
          JSON.stringify(request.state.header),
          request.state.sdkVersion,
          request.state.nativeFormatVersion,
          task.execution_snapshot_id,
          authority.attemptId,
          authority.ownerId,
          authority.generation,
          request.key,
          request.hash,
          request.reason,
        ],
      );
      await client.query(
        'UPDATE pi_sessions SET head_revision_id=$2,updated_at=clock_timestamp() WHERE id=$1',
        [session.id, revisionId],
      );
      await client.query('UPDATE agent_attempts SET last_committed_revision_id=$2 WHERE id=$1', [
        authority.attemptId,
        revisionId,
      ]);
      await apply?.(client, revisionId, request.effects);
      commitSent = true;
      await client.query('COMMIT');
      return revisionId;
    } catch (error) {
      // Abort immediately. Reconnection/verification must never postpone cancellation.
      this.failClosed();
      // Discarding the connection rolls back uncommitted work without waiting for a dead DB.
      client.release(true);
      released = true;
      if (commitSent) {
        // The original immutable key is the only verification identity. A historical success
        // still leaves the caller cancelled; the next send must separately acquire authority.
        const saved = await this.lookup(authority.piSessionId, request.key, request.hash).catch(
          () => null,
        );
        if (saved) return saved;
        throw new NativeCommitOutcomeUnknownError(authority.piSessionId, request.key, request.hash);
      }
      throw error;
    } finally {
      if (!released) client.release();
    }
  }
}
