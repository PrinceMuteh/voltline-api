import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  CurrentAuth,
  Roles,
  type AuthContext,
} from '../auth/auth.decorators.js';
import { AlertsService } from './alerts.service.js';
import { AlertDto } from './dto/alert.dto.js';

@ApiTags('console')
@ApiCookieAuth()
@Controller('console/alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @ApiOkResponse({ type: [AlertDto] })
  list(@CurrentAuth() auth: AuthContext) {
    return this.alerts.listOpen(auth);
  }

  @Post(':id/resolve')
  @HttpCode(204)
  @Roles('ADMIN', 'OPERATOR', 'SUPPORT')
  resolve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.alerts.resolve(auth, id);
  }
}
