/**
 * Composition happens HERE and nowhere else (docs/design/T-019.md §2.3, §4.1,
 * §4.6, §5.10; AC-8).
 *
 * Every consumer downstream of this file holds a PORT: `CommsService`,
 * `CommsStore`, `RawPayloadStore`, `EventQueue`, `ObjectStore`, `ReceiptStore`,
 * `StoreSessionFactory`. None of them branches on the backing store, and
 * `StoragePlan` is read in exactly two places — here, and `/readyz`.
 *
 * ADR-008, made structural rather than promised:
 *
 *  - The plan is computed BEFORE any I/O (`config/storage.ts`).
 *  - The in-memory pair is built only when `plan.relational === 'memory'`.
 *  - The Postgres branch runs `handle.ping()` as a PREFLIGHT and returns a
 *    failure when it does not resolve `ok`. The caller exits non-zero.
 *  - **There is no `catch` in the Postgres branch that falls through to the
 *    memory branch.** That branch does not exist. Silent degradation is not
 *    prevented by a check here; it is prevented by there being no code to
 *    perform it.
 */

import { InMemoryCommsStore, InMemoryQueue, InMemoryRawPayloadStore, createCommsService } from '@comms';
import type { CommsService, CommsStore, EventQueue, RawPayloadStore } from '@comms';
import type { EmailAdapter, IsoTimestamp, TelephonyAdapter } from '@core';
import { createDbHandle, type DbHandle } from '@db';
import { createInMemoryObjectStore, createS3ObjectStore, createS3RawPayloadStore } from '@object-store';
import type { ObjectStore, S3RawPayloadStore } from '@object-store';
import { createInMemoryReceiptStore } from '@receipt';
import type { ReceiptStore } from '@receipt';

import {
  createMemoryStoreSessionFactory,
  createScopedReadModel,
  type ScopedReadModel,
  type StoreSessionFactory,
} from '../auth/scoped-store.js';
import type { AccountScopeShape } from '../context/account-context.js';
import type { ApiConfig } from '../config/env.js';
import type { StoragePlan } from '../config/storage.js';
import { apiError, fail, ok, type ApiResult } from '../errors/envelope.js';
import { fromDbError } from '../errors/mapping.js';
import type { ApiLogger } from '../http/request-log.js';
import { createUnwiredEmailAdapter, createUnwiredTelephonyAdapter } from './adapters.js';
import { createUnavailableRelationalBinder, type RelationalBinder } from './relational.js';

export interface AppContainer {
  readonly plan: StoragePlan;
  /** `@comms`, already wired: webhook intake, note intake, read model. */
  readonly comms: CommsService;
  /** The ONLY read path a handler may use — every method takes a `DealHandle`. */
  readonly read: ScopedReadModel;
  /** The ONLY write path — same rule. */
  readonly sessions: StoreSessionFactory;
  readonly objects: ObjectStore;
  readonly queue: EventQueue;
  readonly receiptsFor: (scope: AccountScopeShape) => ReceiptStore;
  /** Ordered teardown (§4.6). Idempotent. */
  close(): Promise<void>;
}

export interface ContainerDeps {
  readonly config: ApiConfig;
  readonly plan: StoragePlan;
  /** Fixture/unwired adapters in E2; a later epic supplies real ones behind the same `@core` contracts. */
  readonly telephony?: TelephonyAdapter;
  readonly email?: EmailAdapter;
  /** Deterministic seams — the same two `@comms` declares. */
  readonly now?: () => IsoTimestamp;
  readonly new_event_id?: () => string;
  readonly log?: ApiLogger;
  /**
   * The `@store-pg` plug (§8.6). Defaults to the binder that REFUSES, so a
   * configured database aborts startup rather than degrading. Injectable so the
   * Postgres composition path is exercisable before T-017 exists.
   */
  readonly relational_binder?: RelationalBinder;
}

export async function createContainer(deps: ContainerDeps): Promise<ApiResult<AppContainer>> {
  const { config, plan } = deps;
  const log: ApiLogger = deps.log ?? (() => {});

  // ---- object plane ------------------------------------------------------
  // Chosen from `plan.objects`, which was fixed before any I/O. A partial
  // object-store configuration never reaches here: `resolveStoragePlan`
  // already aborted on it.
  let objects: ObjectStore;
  let raw_payloads: RawPayloadStore;
  let flushable: S3RawPayloadStore | undefined;

  if (plan.objects === 's3') {
    const configured = config.object_store;
    if (configured === undefined || !configured.ok) {
      return fail(apiError('internal', 'storage plan says s3 but no object-store configuration is present'));
    }
    objects = createS3ObjectStore(configured.value);
    const s3_raw = createS3RawPayloadStore(configured.value);
    flushable = s3_raw;
    raw_payloads = s3_raw;
  } else {
    objects = createInMemoryObjectStore();
    raw_payloads = new InMemoryRawPayloadStore();
  }

  if (plan.raw_payload_durability === 'volatile') {
    // D7/§8.4: permitted, because ADR-008 treats the two switches as
    // independent — but never silent. Durable rows will reference raw-payload
    // bytes that do not survive a restart, and `/readyz` says so too.
    log({
      level: 'warn',
      event: 'raw_payload_store_volatile',
      message: 'postgres is configured without an object store; raw payloads do not survive a restart',
    });
  }

  // ---- relational plane --------------------------------------------------
  const queue: EventQueue = new InMemoryQueue();

  let store: CommsStore;
  let receiptsFor: (scope: AccountScopeShape) => ReceiptStore;
  let sessions: StoreSessionFactory;
  let db: DbHandle | undefined;
  let closeRelational: () => Promise<void> = () => Promise.resolve();

  if (plan.relational === 'postgres') {
    const database = config.database;
    if (database === undefined) {
      return fail(apiError('internal', 'storage plan says postgres but no database configuration is present'));
    }

    // Creating the handle is LAZY (`@db` opens no socket until first use), so
    // the preflight below is the first and only place a failure can appear —
    // and it appears before `listen`.
    const handle = createDbHandle(database);
    const pinged = await handle.ping();
    if (!pinged.ok) {
      log({
        level: 'fatal',
        event: 'db_preflight_failed',
        message: 'database preflight failed; refusing to start',
        detail: { code: pinged.error.code },
      });
      await handle.close();
      return fail(fromDbError(pinged.error));
    }

    const binder = deps.relational_binder ?? createUnavailableRelationalBinder();
    const bound = await binder.bind({ handle });
    if (!bound.ok) {
      await handle.close();
      return fail(bound.error);
    }

    db = handle;
    store = bound.value.store;
    receiptsFor = bound.value.receiptsFor;
    sessions = bound.value.sessions;
    closeRelational = async (): Promise<void> => {
      await bound.value.close();
    };
  } else {
    const memory_store = new InMemoryCommsStore();
    // `@receipt`'s in-memory store is keyed by `receipt_bundle_id` and has no
    // account column. The binding is nominal in this mode and the real
    // containment is upstream: a bundle id is only ever obtained by reading a
    // deal through `ScopedReadModel`, which re-checks `owner_id`.
    const memory_receipts =
      deps.now === undefined ? createInMemoryReceiptStore() : createInMemoryReceiptStore(deps.now);
    store = memory_store;
    receiptsFor = () => memory_receipts;
    sessions = createMemoryStoreSessionFactory({ store: memory_store, raw_payloads, receiptsFor: () => memory_receipts });
  }

  // ---- @comms, over whichever store the plan chose -----------------------
  const comms = createCommsService({
    telephony: deps.telephony ?? createUnwiredTelephonyAdapter(),
    email: deps.email ?? createUnwiredEmailAdapter(),
    queue,
    store,
    raw_payloads,
    ...(deps.now !== undefined && { now: deps.now }),
    ...(deps.new_event_id !== undefined && { new_event_id: deps.new_event_id }),
  });

  const read = createScopedReadModel({
    read: comms.read,
    log: (event) =>
      log({
        level: 'warn',
        event: 'auth_posture',
        message: 'read rejected: deal is not owned by the requesting account',
        detail: { layer: event.layer, account_id: event.account_id, deal_id: event.deal_id },
      }),
  });

  log({
    level: 'info',
    event: 'storage_plan',
    message: 'storage plan resolved',
    detail: {
      relational: plan.relational,
      objects: plan.objects,
      raw_payload_durability: plan.raw_payload_durability,
    },
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // §4.6 order. (1) is `app.close()` and belongs to the caller; from here:
    // (2) drain the write-behind window — skipping it discards payloads the
    // process already told a provider it had accepted; (3) close the DB handle,
    // AFTER the flush, because a flushed payload may still be referenced by a
    // row the same shutdown is committing.
    if (flushable !== undefined) {
      await flushable.flush();
      const failed = flushable.failedRefs();
      if (failed.length > 0) {
        log({
          level: 'error',
          event: 'raw_payload_flush_incomplete',
          message: 'raw payloads could not be made durable before shutdown',
          detail: { count: failed.length, ref_prefixes: failed.map((ref) => ref.slice(0, 12)).join(',') },
        });
      }
    }
    await closeRelational();
    if (db !== undefined) await db.close();
  };

  return ok({ plan, comms, read, sessions, objects, queue, receiptsFor, close });
}
