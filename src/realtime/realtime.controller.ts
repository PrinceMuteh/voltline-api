import { Controller, HttpCode, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, type AuthContext } from '../auth/auth.decorators.js';
import { RealtimeTicketDto } from './dto/realtime.dto.js';
import type { TicketPayload } from './realtime.gateway.js';

@ApiTags('console')
@ApiCookieAuth()
@Controller('console/realtime')
export class RealtimeController {
  constructor(private readonly jwt: JwtService) {}

  /** A 60-second ticket the browser passes when it opens the /console socket. */
  @Post('ticket')
  @HttpCode(200)
  @ApiOkResponse({ type: RealtimeTicketDto })
  async ticket(@CurrentAuth() auth: AuthContext): Promise<RealtimeTicketDto> {
    const payload: TicketPayload = {
      typ: 'rt',
      wid: auth.workspaceId,
      mid: auth.memberId,
    };
    return { ticket: await this.jwt.signAsync(payload, { expiresIn: 60 }) };
  }
}
