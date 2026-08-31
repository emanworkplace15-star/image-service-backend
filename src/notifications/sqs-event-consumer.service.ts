import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ImagesService } from '../images/images.service';
import { parseProcessorEvent } from './events';

// Same no-static-key rule as S3Service: the SQSClient relies on the AWS SDK
// default credential chain (IAM role in prod, env vars in local dev).
@Injectable()
export class SqsEventConsumerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private static readonly RECEIVE_SECONDS = 20;
  private static readonly VISIBILITY_SECONDS = 60;

  private readonly logger = new Logger(SqsEventConsumerService.name);
  private readonly enabled: boolean;
  private readonly sqs: SQSClient | null;
  private readonly queueUrl: string | null;
  private running = false;

  // ImagesService is resolved lazily (not via constructor injection) to avoid
  // a circular provider dependency: ImagesService broadcasts through the
  // gateway, and this consumer calls back into ImagesService.
  constructor(private readonly moduleRef: ModuleRef) {
    const mode = process.env.NOTIFY_MODE ?? 'api';
    this.enabled = mode === 'sqs';
    if (this.enabled) {
      const queueUrl = process.env.SQS_QUEUE_URL;
      const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      if (!queueUrl) {
        throw new Error('SQS_QUEUE_URL must be set when NOTIFY_MODE=sqs');
      }
      if (!region) {
        throw new Error('AWS_REGION (or AWS_DEFAULT_REGION) must be set');
      }
      this.queueUrl = queueUrl;
      this.sqs = new SQSClient({ region });
    }
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.running = true;
    void this.pollLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.sqs?.destroy();
  }

  private async pollLoop(): Promise<void> {
    this.logger.log(`Consuming processor events from SQS ${this.queueUrl}`);
    while (this.running) {
      const messages = await this.receiveMessages();
      for (const message of messages) {
        await this.handleMessage(message);
      }
    }
  }

  private resolveImagesService(): ImagesService {
    return this.moduleRef.get(ImagesService, { strict: false });
  }

  private async receiveMessages(): Promise<Record<string, any>[]> {
    try {
      const res = await this.sqs!.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl!,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: SqsEventConsumerService.RECEIVE_SECONDS,
          VisibilityTimeout: SqsEventConsumerService.VISIBILITY_SECONDS,
        }),
      );
      return res.Messages ?? [];
    } catch (err) {
      if (!this.running) return []; // shutting down
      this.logger.error(`SQS receive failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  // SQS is at-least-once: messages redeliver after the visibility timeout
  // unless deleted. The DB updates in ImagesService are idempotent, so a lost
  // delete just causes a duplicate broadcast.
  private async handleMessage(message: Record<string, any>): Promise<void> {
    const body = message.Body;
    let event;
    try {
      event = parseProcessorEvent(JSON.parse(body));
    } catch {
      this.logger.warn(`Ignoring unparseable message ${message.MessageId}`);
      await this.delete(message.ReceiptHandle);
      return;
    }
    if (!event) {
      this.logger.warn(`Ignoring invalid event ${message.MessageId}: ${body}`);
      await this.delete(message.ReceiptHandle);
      return;
    }

    try {
      await this.resolveImagesService().applyProcessorEvent(event);
    } catch (err) {
      if (err instanceof NotFoundException) {
        // Same 404-tolerance as the HTTP callback path: no DB row for this key
        // (e.g. a manual S3 upload). Not worth redelivering.
        this.logger.warn(`No record for ${event.originalKey}, skipping`);
        await this.delete(message.ReceiptHandle);
        return;
      }
      this.logger.error(
        `Failed to apply event ${message.MessageId}: ${err instanceof Error ? err.message : err}`,
      );
      return; // don't delete — SQS redelivers after the visibility timeout
    }
    await this.delete(message.ReceiptHandle);
  }

  private async delete(receiptHandle: string): Promise<void> {
    try {
      await this.sqs!.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl!,
          ReceiptHandle: receiptHandle,
        }),
      );
    } catch (err) {
      if (this.running) {
        this.logger.error(`SQS delete failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}