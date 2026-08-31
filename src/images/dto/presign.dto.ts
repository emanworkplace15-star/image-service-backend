import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

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

export class ProcessorEventDto {
  @IsIn(['processed', 'failed'])
  type!: 'processed' | 'failed';

  @IsString()
  originalKey!: string;

  @IsOptional()
  @IsString()
  processedKey?: string;

  @IsOptional()
  @IsNumber()
  processedSize?: number;

  @IsOptional()
  @IsString()
  failureReason?: string;

  @IsOptional()
  @IsISO8601()
  occurredAt?: string;
}

export class DeleteImagesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  ids!: string[];
}
