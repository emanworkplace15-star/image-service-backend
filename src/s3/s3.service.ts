import { Injectable } from '@nestjs/common';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// No credentials are passed to the S3Client on purpose: the AWS SDK default
// credential chain resolves them. This works with:
//  - EKS (IRSA / Pod Identity), ECS task role, EC2 instance profile (no keys)
//  - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars (local dev)
//  - ~/.aws/credentials (local dev)
@Injectable()
export class S3Service {
  readonly client: S3Client;
  readonly bucket: string;
  readonly presignExpires: number;

  constructor() {
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new Error('AWS_REGION (or AWS_DEFAULT_REGION) must be set');
    }
    const bucket = process.env.S3_BUCKET;
    if (!bucket) {
      throw new Error('S3_BUCKET must be set');
    }
    this.bucket = bucket;
    this.presignExpires = Number(process.env.PRESIGN_EXPIRES ?? 3600);
    this.client = new S3Client({ region });
  }

  presignPut(key: string, contentType: string): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn: 900 });
  }

  presignGet(key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: this.presignExpires,
    });
  }

  async headObject(key: string): Promise<{
    exists: boolean;
    contentLength?: number;
  }> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { exists: true, contentLength: head.ContentLength };
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
        return { exists: false };
      }
      throw err;
    }
  }
}
