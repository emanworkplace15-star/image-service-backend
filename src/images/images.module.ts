import { Module } from '@nestjs/common';
import {
  ImagesController,
  InternalImagesController,
} from './images.controller';
import { ImagesService } from './images.service';

@Module({
  controllers: [ImagesController, InternalImagesController],
  providers: [ImagesService],
})
export class ImagesModule {}
