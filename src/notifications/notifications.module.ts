import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SqsEventConsumerService } from './sqs-event-consumer.service';
import { ImageEventsGateway } from './image-events.gateway';

@Module({
  imports: [JwtModule.register({})],
  providers: [ImageEventsGateway, SqsEventConsumerService],
  exports: [ImageEventsGateway],
})
export class NotificationsModule {}