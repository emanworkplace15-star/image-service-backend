import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';

// Shared-secret guard for the Lambda -> backend callback endpoint.
@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.LAMBDA_API_KEY;
    if (!expected) {
      throw new UnauthorizedException('LAMBDA_API_KEY is not configured');
    }
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header('x-api-key');
    // Hash both sides so timingSafeEqual always gets equal-length buffers
    // (it throws on length mismatch, which would leak a 500).
    const providedHash = crypto
      .createHash('sha256')
      .update(String(provided ?? ''))
      .digest();
    const expectedHash = crypto
      .createHash('sha256')
      .update(expected)
      .digest();
    if (!provided || !crypto.timingSafeEqual(providedHash, expectedHash)) {
      throw new UnauthorizedException('Invalid API key');
    }
    return true;
  }
}
