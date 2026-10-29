import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import {
  DriversPageDto,
  DriversQueryDto,
  DriverStatusResultDto,
  FleetInputDto,
  FleetSummaryDto,
  IssueCardDto,
  IssuedCardDto,
  ReadCardResultDto,
} from './dto/drivers.dto.js';
import { DriversService } from './drivers.service.js';

@ApiTags('console')
@ApiCookieAuth()
@Controller('console')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get('drivers')
  @ApiOkResponse({ type: DriversPageDto })
  page(@CurrentAuth() auth: AuthContext, @Query() query: DriversQueryDto) {
    return this.drivers.page(auth, query.q);
  }

  @Post('drivers/:id/block')
  @HttpCode(200)
  @Roles('ADMIN', 'OPERATOR')
  @ApiOkResponse({ type: DriverStatusResultDto })
  block(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.drivers.setBlocked(auth, id, true);
  }

  @Post('drivers/:id/unblock')
  @HttpCode(200)
  @Roles('ADMIN', 'OPERATOR')
  @ApiOkResponse({ type: DriverStatusResultDto })
  unblock(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.drivers.setBlocked(auth, id, false);
  }

  @Post('id-tokens')
  @Roles('ADMIN', 'OPERATOR')
  @ApiCreatedResponse({ type: IssuedCardDto })
  issueCard(@CurrentAuth() auth: AuthContext, @Body() dto: IssueCardDto) {
    return this.drivers.issueCard(auth, dto);
  }

  @Post('fleets')
  @Roles('ADMIN', 'OPERATOR')
  @ApiCreatedResponse({ type: FleetSummaryDto })
  createFleet(@CurrentAuth() auth: AuthContext, @Body() dto: FleetInputDto) {
    return this.drivers.createFleet(auth, dto);
  }

  @Post('chargers/:id/read-card')
  @HttpCode(200)
  @Roles('ADMIN', 'OPERATOR')
  @ApiOkResponse({ type: ReadCardResultDto })
  readCard(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.drivers.readCard(auth, id);
  }
}
