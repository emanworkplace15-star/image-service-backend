import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Image, ImageStatus } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import {
  EXTENSION_BY_CONTENT_TYPE,
  PresignDto,
} from './dto/presign.dto';
import { ProcessorEventDto } from './dto/presign.dto';
import { ImageEventsGateway } from '../notifications/image-events.gateway';
import { SocketFailedPayload, SocketProcessedPayload } from '../notifications/events';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 12;

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

@Injectable()
export class ImagesService {
  constructor(
    private prisma: PrismaService,
    private s3: S3Service,
    private events: ImageEventsGateway,
  ) {}

  async presign(dto: PresignDto) {
    const ext = EXTENSION_BY_CONTENT_TYPE[dto.contentType];
    const id = crypto.randomUUID();
    const originalKey = `uploads/${id}${ext}`;

    const image = await this.prisma.image.create({
      data: {
        id,
        originalKey,
        contentType: dto.contentType,
        status: ImageStatus.PENDING,
      },
    });

    const uploadUrl = await this.s3.presignPut(
      image.originalKey,
      dto.contentType,
    );
    return { id: image.id, key: image.originalKey, uploadUrl };
  }

  async complete(id: string) {
    const image = await this.prisma.image.findUnique({ where: { id } });
    if (!image) {
      throw new NotFoundException('Image not found');
    }

    const head = await this.s3.headObject(image.originalKey);
    if (!head.exists) {
      throw new BadRequestException(
        'Original object not found in S3 — was the upload completed?',
      );
    }

    // Never downgrade PROCESSED back to UPLOADED if the Lambda callback
    // landed before this endpoint was called.
    await this.prisma.image.updateMany({
      where: { id, status: ImageStatus.PENDING },
      data: {
        status: ImageStatus.UPLOADED,
        originalSize: head.contentLength ?? null,
      },
    });

    return { id, status: 'UPLOADED' };
  }

  // Entry point for both notification legs: the HTTP callback from the Lambda
  // (NOTIFY_MODE=api) and the SQS consumer (NOTIFY_MODE=sqs). Broadcasting
  // here means every path that mutates a row also pushes the socket event.
  async applyProcessorEvent(dto: ProcessorEventDto) {
    if (dto.type === 'failed') {
      return this.markFailed(dto);
    }
    return this.markProcessed(dto);
  }

  async markProcessed(dto: ProcessorEventDto) {
    if (!dto.processedKey || typeof dto.processedSize !== 'number') {
      throw new BadRequestException(
        'processedKey and processedSize are required for type=processed',
      );
    }
    try {
      const updated = await this.prisma.image.update({
        where: { originalKey: dto.originalKey },
        data: {
          status: ImageStatus.PROCESSED,
          processedKey: dto.processedKey,
          processedSize: Math.trunc(dto.processedSize),
        },
      });
      const url = dto.processedKey
        ? await this.s3.presignGet(dto.processedKey)
        : null;
      this.events.broadcastImageProcessed({
        id: updated.id,
        originalKey: updated.originalKey,
        processedKey: updated.processedKey,
        processedSize: updated.processedSize,
        url,
        occurredAt: dto.occurredAt,
      });
      return { id: updated.id, status: updated.status };
    } catch (err: any) {
      if (err?.code === 'P2025') {
        throw new NotFoundException(
          `No image record for originalKey=${dto.originalKey}`,
        );
      }
      throw err;
    }
  }

  async markFailed(dto: ProcessorEventDto) {
    const image = await this.prisma.image.findUnique({
      where: { originalKey: dto.originalKey },
    });
    if (!image) {
      // 404-tolerance for manual S3 uploads with no DB row.
      throw new NotFoundException(
        `No image record for originalKey=${dto.originalKey}`,
      );
    }
    if (image.status === ImageStatus.PROCESSED) {
      // Already finished successfully — never downgrade to FAILED.
      return { id: image.id, status: image.status };
    }
    await this.prisma.image.update({
      where: { id: image.id },
      data: {
        status: ImageStatus.FAILED,
        failureReason: dto.failureReason,
      },
    });
    this.events.broadcastImageFailed({
      id: image.id,
      originalKey: image.originalKey,
      failureReason: dto.failureReason,
      occurredAt: dto.occurredAt,
    });
    return { id: image.id, status: 'FAILED' };
  }

  async gallery(page: number, limit: number) {
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const safePage = Math.max(page, 1);

    const [total, rows] = await Promise.all([
      this.prisma.image.count(),
      this.prisma.image.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
    ]);

    const data = await Promise.all(
      rows.map(async (image: Image) => ({
        id: image.id,
        status: image.status,
        originalSize: image.originalSize,
        processedSize: image.processedSize,
        createdAt: image.createdAt,
        url: await this.s3.presignGet(
          image.processedKey ?? image.originalKey,
        ),
      })),
    );

    return this.paginate(data, safePage, safeLimit, total);
  }

  async findAll(page: number, limit: number) {
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const safePage = Math.max(page, 1);

    const [total, rows] = await Promise.all([
      this.prisma.image.count(),
      this.prisma.image.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
    ]);

    return this.paginate(rows, safePage, safeLimit, total);
  }

  async remove(ids: string[]) {
    const rows = await this.prisma.image.findMany({
      where: { id: { in: ids } },
    });

    const keys = rows.flatMap((image) =>
      image.processedKey
        ? [image.originalKey, image.processedKey]
        : [image.originalKey],
    );
    // S3 first: a DB-only delete would strand the objects; failing S3 before
    // the row is gone is safe to retry (DeleteObjects is tolerant of missing keys).
    await this.s3.deleteObjects(keys);
    await this.prisma.image.deleteMany({ where: { id: { in: ids } } });

    return { deleted: rows.length };
  }

  private paginate<T>(
    data: T[],
    page: number,
    limit: number,
    total: number,
  ): { data: T[] } & PaginationMeta {
    return {
      data,
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    };
  }
}
