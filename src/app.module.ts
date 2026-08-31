import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ImagesModule } from './images/images.module';
import { PrismaModule } from './prisma/prisma.module';
import { S3Module } from './s3/s3.module';

@Module({
  imports: [PrismaModule, S3Module, AuthModule, ImagesModule],
})
export class AppModule {}
