import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentAuth, type AuthContext } from '../auth/auth.decorators.js';
import {
  SessionDetailDto,
  SessionListDto,
  SessionsQueryDto,
} from './dto/session.dto.js';
import { SessionsService } from './sessions.service.js';

@ApiTags('console')
@ApiCookieAuth()
@Controller('console/sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  @ApiOkResponse({ type: SessionListDto })
  list(@CurrentAuth() auth: AuthContext, @Query() query: SessionsQueryDto) {
    return this.sessions.list(auth, query);
  }

  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="voltline-sessions.csv"')
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'Sessions as CSV, with the same filters as the list',
  })
  csv(@CurrentAuth() auth: AuthContext, @Query() query: SessionsQueryDto) {
    return this.sessions.csv(auth, query);
  }

  @Get(':id')
  @ApiOkResponse({ type: SessionDetailDto })
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sessions.detail(auth, id);
  }
}
