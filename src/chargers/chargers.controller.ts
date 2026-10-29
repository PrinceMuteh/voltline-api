import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import { CommandsService } from '../ocpp/commands.service.js';
import { ConfigurationService } from '../ocpp/configuration.service.js';
import { LocalListService } from '../ocpp/local-list.service.js';
import { ReservationsService } from '../ocpp/reservations.service.js';
import { ChargersService } from './chargers.service.js';
import {
  ChargerDetailDto,
  ChargerRowDto,
  CommandDto,
  ConfigItemDto,
  IdTokenDto,
  LocalListResultDto,
  ReserveDto,
  ReserveResultDto,
  ConfigWriteDto,
  ConfigWriteResultDto,
  CommandResultDto,
  ConnectCheckDto,
  CreateChargerDto,
  CreatedChargerDto,
  MessagePageDto,
  MessageSearchDto,
  NetworkDto,
  NextIdDto,
  OcppMessageDto,
  PasswordDto,
  UpdateChargerDto,
} from './dto/charger.dto.js';

const uuid = new ParseUUIDPipe();

@ApiTags('console')
@ApiCookieAuth()
@Controller('console')
export class ChargersController {
  constructor(
    private readonly chargers: ChargersService,
    private readonly commands: CommandsService,
    private readonly configuration: ConfigurationService,
    private readonly reservations: ReservationsService,
    private readonly localList: LocalListService,
  ) {}

  @Get('chargers')
  @ApiOkResponse({ type: [ChargerRowDto] })
  list(@CurrentAuth() auth: AuthContext) {
    return this.chargers.list(auth);
  }

  @Get('chargers/next-id')
  @ApiOkResponse({ type: NextIdDto })
  nextId(@CurrentAuth() auth: AuthContext) {
    return this.chargers.nextId(auth);
  }

  @Post('chargers')
  @Roles('ADMIN', 'OPERATOR')
  @ApiCreatedResponse({ type: CreatedChargerDto })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateChargerDto) {
    return this.chargers.create(auth, dto);
  }

  @Get('chargers/:id')
  @ApiOkResponse({ type: ChargerDetailDto })
  detail(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.chargers.detail(auth, id);
  }

  @Patch('chargers/:id')
  @Roles('ADMIN', 'OPERATOR')
  @ApiOkResponse({ type: ChargerDetailDto })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateChargerDto,
  ) {
    return this.chargers.update(auth, id, dto);
  }

  @Post('chargers/:id/credentials/rotate')
  @HttpCode(200)
  @Roles('ADMIN', 'OPERATOR')
  @ApiOkResponse({ type: PasswordDto })
  rotate(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.chargers.rotatePassword(auth, id);
  }

  @Post('chargers/:id/approve')
  @HttpCode(200)
  @Roles('ADMIN', 'OPERATOR')
  @ApiOkResponse({ type: ChargerDetailDto })
  approve(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.chargers.approve(auth, id);
  }

  @Get('chargers/:id/connect-check')
  @ApiOkResponse({ type: ConnectCheckDto })
  connectCheck(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
  ) {
    return this.chargers.connectCheck(auth, id);
  }

  /** The searchable OCPP log (OC-12), kept 90 days. */
  @Get('chargers/:id/messages/search')
  @ApiOkResponse({ type: MessagePageDto })
  searchMessages(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Query() query: MessageSearchDto,
  ) {
    return this.chargers.searchMessages(auth, id, query);
  }

  @Get('chargers/:id/messages')
  @ApiOkResponse({ type: [OcppMessageDto] })
  messages(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.chargers.recentMessages(auth, id);
  }

  /** Waits for the charger's answer (up to 30 s) so the console can turn its toast into the result. */
  @Post('chargers/:id/commands')
  @HttpCode(200)
  @Roles('ADMIN', 'OPERATOR', 'SUPPORT')
  @ApiOkResponse({ type: CommandResultDto })
  command(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: CommandDto,
  ) {
    return this.commands.run(auth, id, dto.kind, dto.evseId);
  }

  @Post('chargers/:id/commands/:commandId/cancel')
  @HttpCode(204)
  @Roles('ADMIN', 'OPERATOR', 'SUPPORT')
  cancelCommand(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('commandId', uuid) commandId: string,
  ) {
    return this.commands.cancel(auth, id, commandId);
  }

  /** Live from the charger (GetVariables / GetConfiguration); it must be connected. */
  @Get('chargers/:id/configuration')
  @Roles('ADMIN', 'OPERATOR', 'SUPPORT')
  @ApiOkResponse({ type: [ConfigItemDto] })
  readConfiguration(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
  ) {
    return this.configuration.read(auth, id);
  }

  @Put('chargers/:id/configuration')
  @Roles('ADMIN', 'OPERATOR')
  @ApiOkResponse({ type: ConfigWriteResultDto })
  writeConfiguration(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: ConfigWriteDto,
  ) {
    return this.configuration.write(auth, id, dto);
  }

  /** Holds a connector for one card (ReserveNow); the charger must be connected. */
  @Post('chargers/:id/reservations')
  @HttpCode(200)
  @Roles('ADMIN', 'OPERATOR', 'SUPPORT')
  @ApiOkResponse({ type: ReserveResultDto })
  reserve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: ReserveDto,
  ) {
    return this.reservations.reserve(auth, id, dto);
  }

  @Post('chargers/:id/reservations/:reservationId/cancel')
  @HttpCode(204)
  @Roles('ADMIN', 'OPERATOR', 'SUPPORT')
  cancelReservation(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('reservationId', uuid) reservationId: string,
  ) {
    return this.reservations.cancel(auth, id, reservationId);
  }

  /** Sends the active RFID cards now (also sent automatically when a charger connects). */
  @Post('chargers/:id/local-list/sync')
  @HttpCode(200)
  @Roles('ADMIN', 'OPERATOR')
  @ApiOkResponse({ type: LocalListResultDto })
  syncLocalList(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
  ) {
    return this.localList.syncFromConsole(auth, id);
  }

  @Get('id-tokens')
  @ApiOkResponse({ type: [IdTokenDto] })
  idTokens(@CurrentAuth() auth: AuthContext) {
    return this.chargers.idTokens(auth);
  }

  /** Stop from the session drawer; answers like any other command. */
  @Post('sessions/:id/stop')
  @HttpCode(200)
  @Roles('ADMIN', 'OPERATOR', 'SUPPORT')
  @ApiOkResponse({ type: CommandResultDto })
  stopSession(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.commands.stopSession(auth, id);
  }

  @Get('network')
  @ApiOkResponse({ type: NetworkDto })
  network(@CurrentAuth() auth: AuthContext) {
    return this.chargers.network(auth);
  }
}
