import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Public } from '../auth/public.decorator';
import { ApiKeyGuard } from './api-key.guard';
import { PresignDto, ProcessedCallbackDto } from './dto/presign.dto';
import { ImagesService } from './images.service';

@UseGuards(JwtAuthGuard)
@Controller('images')
export class ImagesController {
  constructor(private imagesService: ImagesService) {}

  @Post('presign')
  presign(@Body() dto: PresignDto) {
    return this.imagesService.presign(dto);
  }

  @Post(':id/complete')
  complete(@Param('id') id: string) {
    return this.imagesService.complete(id);
  }

  @Public()
  @Get('gallery')
  gallery(
    @Query('page') page = '1',
    @Query('limit') limit = '12',
  ) {
    return this.imagesService.gallery(Number(page), Number(limit));
  }

  @Get()
  findAll(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.imagesService.findAll(Number(page), Number(limit));
  }
}

@Controller('internal/images')
export class InternalImagesController {
  constructor(private imagesService: ImagesService) {}

  // Called by the image-processor Lambda with a shared x-api-key.
  @UseGuards(ApiKeyGuard)
  @Post('processed')
  markProcessed(@Body() dto: ProcessedCallbackDto) {
    return this.imagesService.markProcessed(dto);
  }
}
