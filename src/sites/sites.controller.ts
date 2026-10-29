import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CurrentAuth,
  Roles,
  type AuthContext,
} from '../auth/auth.decorators.js';
import { SiteDto, SiteInputDto, SiteUpdateDto } from './dto/site.dto.js';
import { SitesService } from './sites.service.js';

@ApiTags('console')
@ApiCookieAuth()
@Controller('console/sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  @ApiOkResponse({ type: [SiteDto] })
  list(@CurrentAuth() auth: AuthContext) {
    return this.sites.list(auth);
  }

  @Post()
  @Roles('ADMIN', 'OPERATOR')
  @ApiCreatedResponse({ type: SiteDto })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: SiteInputDto) {
    return this.sites.create(auth, dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'OPERATOR')
  @ApiOkResponse({ type: SiteDto })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SiteUpdateDto,
  ) {
    return this.sites.update(auth, id, dto);
  }
}
