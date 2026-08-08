/**
 * The S3-compatible backend — THE ONLY MODULE IN THE REPO THAT IMPORTS
 * `@aws-sdk/client-s3` (docs/design/T-018.md §1.1, §5.4; ADR-008).
 *
 * specs/00 "Integrations — anti-corruption / adapter layer (shared)": "Every
 * external feed sits behind one internal interface. Core services never see a
 * provider's shape." That is mechanically checkable here:
 *
 *     grep -rn "@aws-sdk" packages/object-store/src   →   exactly this file
 *
 * This module is NOT exported from the barrel. No `PutObjectCommand`,
 * `GetObjectCommandOutput`, `S3ServiceException`, or stream type appears in any
 * exported signature anywhere in the package; `transformToByteArray()` below is
 * the only place a stream type exists at all. Swapping to another
 * S3-compatible provider is a config change; swapping the SDK is this one file.
 *
 * No credential is ever a parameter. The SDK's standard provider chain
 * (environment, profile, instance role) supplies them, so no key or secret can
 * be written into this repo — credential absence is the structural enforcement
 * the constitution relies on. There is no presigned-URL path: that would be a
 * new dependency (`@aws-sdk/s3-request-presigner`) and an escalation (D8).
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { IsoTimestamp } from '@core';
import type {
  BackendHead,
  BackendListOptions,
  BackendListPage,
  BackendMetadata,
  BackendObject,
  BackendPutInput,
  ObjectBackend,
} from './backend.js';
import { toAdapterError } from './backend.js';
import type { ObjectStoreConfig, ObjectStoreResult } from './contract.js';
import { storeError } from './contract.js';

export const S3_SOURCE = 's3-object-store';

const DEFAULT_MAX_ATTEMPTS = 3;

const defaultClock = (): IsoTimestamp => new Date().toISOString();

export function createS3Backend(config: ObjectStoreConfig): ObjectBackend {
  const clock = config.clock ?? defaultClock;
  const bucket = config.bucket;
  const checksums = config.checksums !== false;

  const client = new S3Client({
    region: config.region,
    // ONE retry layer only (§4.2). Two stacked layers turn a 3-attempt policy
    // into 9 and convert a blip into an outage, so nothing in this package
    // adds a loop of its own.
    maxAttempts: config.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
    // D12: a custom endpoint IS the MinIO / non-AWS case, which is exactly when
    // path-style addressing is required. No fourth environment variable.
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
  });

  return {
    source: S3_SOURCE,

    async put(input: BackendPutInput): Promise<ObjectStoreResult<void>> {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: input.key,
            Body: input.bytes,
            ContentType: input.content_type,
            ContentLength: input.bytes.byteLength,
            Metadata: { ...input.metadata },
            ...(checksums ? { ChecksumSHA256: input.content_sha256_base64 } : {}),
            ...(config.server_side_encryption !== undefined
              ? { ServerSideEncryption: config.server_side_encryption }
              : {}),
          }),
        );
        return { ok: true, value: undefined };
      } catch (err) {
        return { ok: false, error: toAdapterError(err, S3_SOURCE, 'put') };
      }
    },

    async get(key: string): Promise<ObjectStoreResult<BackendObject>> {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = response.Body;
        if (body === undefined) {
          // A 200 with no body is a provider-shape drift, not a miss.
          return storeError('malformed_response', S3_SOURCE, 'get returned no body');
        }
        const bytes = await body.transformToByteArray();
        return {
          ok: true,
          value: {
            bytes,
            byte_length: bytes.byteLength,
            ...(response.ContentType !== undefined ? { content_type: response.ContentType } : {}),
            metadata: normalizeMetadata(response.Metadata),
            stored_at: toIso(response.LastModified, clock),
          },
        };
      } catch (err) {
        return { ok: false, error: toAdapterError(err, S3_SOURCE, 'get') };
      }
    },

    async head(key: string): Promise<ObjectStoreResult<BackendHead>> {
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          ok: true,
          value: {
            byte_length: response.ContentLength ?? 0,
            ...(response.ContentType !== undefined ? { content_type: response.ContentType } : {}),
            metadata: normalizeMetadata(response.Metadata),
            stored_at: toIso(response.LastModified, clock),
          },
        };
      } catch (err) {
        return { ok: false, error: toAdapterError(err, S3_SOURCE, 'head') };
      }
    },

    async list(prefix: string, options: BackendListOptions): Promise<ObjectStoreResult<BackendListPage>> {
      try {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: options.limit,
            ...(options.cursor !== undefined ? { ContinuationToken: options.cursor } : {}),
          }),
        );
        const items: { key: string; byte_length: number; stored_at: IsoTimestamp }[] = [];
        for (const entry of response.Contents ?? []) {
          if (entry.Key === undefined) continue;
          items.push({
            key: entry.Key,
            byte_length: entry.Size ?? 0,
            stored_at: toIso(entry.LastModified, clock),
          });
        }
        const truncated = response.IsTruncated === true;
        const next = response.NextContinuationToken;
        return {
          ok: true,
          value: {
            items,
            truncated,
            ...(truncated && next !== undefined ? { next_cursor: next } : {}),
          },
        };
      } catch (err) {
        return { ok: false, error: toAdapterError(err, S3_SOURCE, 'list') };
      }
    },
  };
}

function normalizeMetadata(metadata: Record<string, string> | undefined): BackendMetadata {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function toIso(value: Date | undefined, clock: () => IsoTimestamp): IsoTimestamp {
  return value === undefined ? clock() : value.toISOString();
}
