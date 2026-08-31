import { Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import {
  IMAGE_FAILED_EVENT,
  IMAGE_PROCESSED_EVENT,
  SocketFailedPayload,
  SocketProcessedPayload,
} from './events';

@WebSocketGateway({
  cors: {
    origin:
      !process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === '*'
        ? true
        : process.env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: false,
  },
})
export class ImageEventsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ImageEventsGateway.name);

  @WebSocketServer()
  server: Server | null = null;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = client.handshake.auth?.token;
      if (typeof token !== 'string') {
        throw new UnauthorizedException('Missing token');
      }
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        throw new Error('JWT_SECRET must be set');
      }
      const payload = await this.jwt.verifyAsync(token, { secret });
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });
      if (!user) {
        throw new UnauthorizedException('Unknown user');
      }
    } catch (err) {
      this.logger.warn(`Rejected socket connection: ${err instanceof Error ? err.message : err}`);
      // disconnect() alone rejects the handshake; 'connect_error' cannot be
      // emitted from the server (reserved event) and would crash the process.
      client.disconnect(true);
    }
  }

  broadcastImageProcessed(payload: SocketProcessedPayload): void {
    if (!this.server) return;
    this.server.emit(IMAGE_PROCESSED_EVENT, payload);
  }

  broadcastImageFailed(payload: SocketFailedPayload): void {
    if (!this.server) return;
    this.server.emit(IMAGE_FAILED_EVENT, payload);
  }
}