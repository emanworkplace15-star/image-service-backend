import { IsIn, IsNumber, IsString } from 'class-validator';

const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export class PresignDto {
  @IsIn(ALLOWED_CONTENT_TYPES as unknown as string[])
  contentType!: string;
}

export class ProcessedCallbackDto {
  @IsString()
  originalKey!: string;

  @IsString()
  processedKey!: string;

  @IsNumber()
  processedSize!: number;
}
