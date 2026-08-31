import { Module } from '@nestjs/common';
import {
  ImagesController,
  InternalImagesController,
} from './images.controller';
import { ImagesService } from './images.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [ImagesController, InternalImagesController],
  providers: [ImagesService],
})
export class ImagesModule {}
