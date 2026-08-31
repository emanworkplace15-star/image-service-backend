export const IMAGE_PROCESSED_EVENT = 'image:processed';
export const IMAGE_FAILED_EVENT = 'image:failed';

export type ProcessorEventType = 'processed' | 'failed';

/**
 * Shape of the event the Lambda sends — either directly over HTTP
 * (NOTIFY_MODE=api) or via an SQS message (NOTIFY_MODE=sqs).
 */
export interface ProcessorEvent {
  type: ProcessorEventType;
  originalKey: string;
  processedKey?: string;
  processedSize?: number;
  failureReason?: string;
  occurredAt?: string;
}

export interface SocketProcessedPayload {
  id: string;
  originalKey: string;
  processedKey?: string | null;
  processedSize?: number | null;
  url?: string | null;
  occurredAt?: string;
}

export interface SocketFailedPayload {
  id: string;
  originalKey: string;
  failureReason?: string;
  occurredAt?: string;
}

export function parseProcessorEvent(raw: unknown): ProcessorEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const type = e.type;
  const originalKey = e.originalKey;
  const processedKey = e.processedKey;
  const processedSize = e.processedSize;
  const failureReason = e.failureReason;
  const occurredAt = e.occurredAt;
  if (type !== 'processed' && type !== 'failed') return null;
  if (typeof originalKey !== 'string' || !originalKey) return null;
  if (type === 'processed') {
    if (typeof processedKey !== 'string' || !processedKey) return null;
    if (typeof processedSize !== 'number') return null;
  }
  if (type === 'failed' && typeof failureReason !== 'string') return null;
  if (occurredAt !== undefined && typeof occurredAt !== 'string') return null;
  const event: ProcessorEvent = {
    type,
    originalKey,
  };
  if (processedKey !== undefined) event.processedKey = String(processedKey);
  if (processedSize !== undefined) event.processedSize = Number(processedSize);
  if (failureReason !== undefined) event.failureReason = String(failureReason);
  if (occurredAt !== undefined) event.occurredAt = String(occurredAt);
  return event;
}