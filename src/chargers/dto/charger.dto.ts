import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ApprovalState,
  ChargerStatus,
  CommandStatus,
  ConnectorType,
} from '../../generated/prisma/enums.js';
import {
  COMMAND_KINDS,
  type CommandKind,
} from '../../ocpp/commands.service.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// ─── Input ───────────────────────────────────────────────────────────────────

export class ConnectorInputDto {
  @ApiProperty({ enum: ConnectorType, enumName: 'ConnectorType' })
  @IsEnum(ConnectorType, { message: 'Choose CCS2, Type 2 or CHAdeMO.' })
  type: ConnectorType;

  @ApiProperty({ example: 60, description: 'Maximum power in kW' })
  @IsInt({ message: 'Enter the power as a whole number of kW.' })
  @Min(1, { message: 'Power must be at least 1 kW.' })
  @Max(400, { message: 'Power can be at most 400 kW.' })
  maxKw: number;
}

export class CreateChargerDto {
  @ApiProperty({ example: 'CP-0052' })
  @Transform(trim)
  @Matches(/^[A-Za-z0-9._-]{1,48}$/, {
    message:
      'Use letters, numbers, dots, dashes or underscores, up to 48 characters.',
  })
  chargePointId: string;

  @ApiPropertyOptional({
    description: 'An existing site. Send this or newSiteName.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'Choose a site.' })
  siteId?: string;

  @ApiPropertyOptional({ example: 'Ikeja City Mall' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80, { message: 'Site names are 2 to 80 characters.' })
  newSiteName?: string;

  @ApiPropertyOptional({ example: 'Vendor' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  vendor?: string;

  @ApiPropertyOptional({ example: 'DC60' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  model?: string;

  @ApiProperty({ type: [ConnectorInputDto] })
  @ValidateNested({ each: true })
  @Type(() => ConnectorInputDto)
  @ArrayMinSize(1, { message: 'Add at least one connector.' })
  @ArrayMaxSize(4, { message: 'A charger can have up to 4 connectors here.' })
  connectors: ConnectorInputDto[];
}

/** Everything but the ID can change until the charger is approved. */
export class UpdateChargerDto extends PartialType(
  OmitType(CreateChargerDto, ['chargePointId'] as const),
) {}

export class CommandDto {
  @ApiProperty({ enum: COMMAND_KINDS })
  @IsIn(COMMAND_KINDS)
  kind: CommandKind;

  @ApiPropertyOptional({ description: 'Defaults to EVSE 1' })
  @IsOptional()
  @IsInt()
  @Min(1)
  evseId?: number;
}

// ─── Output ──────────────────────────────────────────────────────────────────

export class ChargerRowDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'CP-0007' }) chargePointId: string;
  @ApiProperty({ type: String, nullable: true, example: 'AC22' })
  model: string | null;
  @ApiProperty({ type: String, nullable: true }) vendor: string | null;
  @ApiProperty() siteId: string;
  @ApiProperty({ example: 'Wuse II Mall' }) siteName: string;
  @ApiProperty({ enum: ChargerStatus, enumName: 'ChargerStatus' })
  status: ChargerStatus;
  @ApiProperty({ enum: ApprovalState, enumName: 'ApprovalState' })
  approval: ApprovalState;
  @ApiProperty({ example: 'Type 2 · 22 kW', description: 'First connector' })
  connector: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Watts, from the latest MeterValues',
  })
  powerW: number | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  lastSeenAt: string | null;
  @ApiProperty({ type: String, nullable: true, example: '2.0.1' })
  protocol: string | null;
  @ApiProperty({ description: 'Has an open OCPP socket right now' })
  connected: boolean;
}

class ConnectorDto {
  @ApiProperty() connectorId: number;
  @ApiProperty({ enum: ConnectorType, enumName: 'ConnectorType' })
  type: ConnectorType;
  @ApiProperty() maxPowerW: number;
  @ApiProperty({ enum: ChargerStatus, enumName: 'ChargerStatus' })
  status: ChargerStatus;
}

class EvseDto {
  @ApiProperty() evseId: number;
  @ApiProperty({ type: [ConnectorDto] }) connectors: ConnectorDto[];
}

class TariffSummaryDto {
  @ApiProperty({ example: 'Standard DC' }) name: string;
  @ApiProperty({ example: 30000 }) perKwhKobo: number;
}

class ActiveSessionDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'S-10482' }) reference: string;
  @ApiProperty() evseId: number;
  @ApiProperty({ format: 'date-time' }) startedAt: string;
  @ApiProperty() energyWh: number;
}

class ReservationDto {
  @ApiProperty() id: string;
  @ApiProperty() evseId: number;
  @ApiProperty({ example: '04:A2:1C:9F' }) idTag: string;
  @ApiProperty({ type: String, nullable: true }) driver: string | null;
  @ApiProperty({ format: 'date-time' }) expiresAt: string;
  @ApiProperty({
    enum: ['REQUESTED', 'ACTIVE', 'USED', 'CANCELLED', 'EXPIRED', 'REJECTED'],
  })
  status: string;
  @ApiProperty({ type: String, nullable: true }) rejection: string | null;
}

export class ChargerDetailDto extends ChargerRowDto {
  @ApiProperty({ type: [ActiveSessionDto] }) activeSessions: ActiveSessionDto[];
  @ApiProperty({ type: [ReservationDto] }) reservations: ReservationDto[];
  @ApiProperty({ description: 'RFID list version last sent (0 = never)' })
  localListVersion: number;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  localListSyncedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) firmwareVersion: string | null;
  @ApiProperty({ example: 2 }) securityProfile: number;
  @ApiProperty({ example: 'wss://ocpp.voltline.example/ocpp/CP-0052' })
  ocppUrl: string;
  @ApiProperty({ type: [EvseDto] }) evses: EvseDto[];
  @ApiProperty({ type: TariffSummaryDto, nullable: true })
  tariff: TariffSummaryDto | null;
}

export class CreatedChargerDto {
  @ApiProperty({ type: ChargerDetailDto }) charger: ChargerDetailDto;
  @ApiProperty({ description: 'Shown once; only a hash is stored' })
  password: string;
}

export class PasswordDto {
  @ApiProperty({ description: 'Shown once; only a hash is stored' })
  password: string;
}

export class NextIdDto {
  @ApiProperty({ example: 'CP-0045' }) chargePointId: string;
}

class CheckItemDto {
  @ApiProperty({ enum: ['waiting', 'done', 'failed'] }) state: string;
  @ApiProperty({ type: String, nullable: true }) detail: string | null;
}

export class ConnectCheckDto {
  @ApiProperty({ type: CheckItemDto }) socket: CheckItemDto;
  @ApiProperty({ type: CheckItemDto }) credentials: CheckItemDto;
  @ApiProperty({ type: CheckItemDto }) boot: CheckItemDto;
  @ApiProperty({ type: CheckItemDto }) connectors: CheckItemDto;
}

export class OcppMessageDto {
  @ApiProperty() id: string;
  @ApiProperty({ format: 'date-time' }) at: string;
  @ApiProperty({ enum: ['INBOUND', 'OUTBOUND'] }) direction: string;
  @ApiProperty({ example: 'MeterValues' }) action: string;
  @ApiProperty({ example: 'Power.Active.Import 7.2 kW' }) summary: string;
  @ApiProperty({ type: 'object', additionalProperties: true })
  payload: Record<string, unknown>;
}

export class MessageSearchDto {
  @ApiPropertyOptional({ description: 'Text in the action or the raw payload' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ example: 'StatusNotification' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  action?: string;

  @ApiPropertyOptional({ enum: ['INBOUND', 'OUTBOUND'] })
  @IsOptional()
  @IsIn(['INBOUND', 'OUTBOUND'])
  direction?: 'INBOUND' | 'OUTBOUND';

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Older than this (the previous page’s nextBefore)',
  })
  @IsOptional()
  @IsISO8601()
  before?: string;
}

export class MessagePageDto {
  @ApiProperty({ type: [OcppMessageDto] }) messages: OcppMessageDto[];
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  nextBefore: string | null;
  @ApiProperty({
    type: [String],
    description: 'Actions seen on this charger (first page only)',
  })
  actions: string[];
}

export class CommandResultDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: CommandStatus, enumName: 'CommandStatus' })
  status: CommandStatus;
  @ApiProperty({ example: 'Connector unlocked' }) title: string;
  @ApiProperty({ example: 'CP-0007 · UnlockConnector.conf Accepted' })
  detail: string;
}

export class NetworkDto {
  @ApiProperty({ description: 'Approved chargers with an open socket' })
  socketsConnected: number;
  @ApiProperty({ description: 'Approved chargers' }) chargers: number;
  @ApiProperty() openAlerts: number;
}

export class ConfigItemDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'OCPPCommCtrlr',
    description: 'OCPP 2.0.1 component; null for 1.6J',
  })
  component: string | null;
  @ApiProperty({ example: 'HeartbeatInterval' }) key: string;
  @ApiProperty({ type: String, nullable: true, example: '300' }) value:
    string | null;
  @ApiProperty() readonly: boolean;
  @ApiProperty({ type: String, nullable: true, example: 'UnknownVariable' })
  note: string | null;
}

export class ConfigWriteDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  component?: string | null;

  @ApiProperty({ example: 'HeartbeatInterval' })
  @IsString()
  @Length(1, 50)
  key: string;

  @ApiProperty({ example: '300' })
  @IsString()
  @MaxLength(1000)
  value: string;
}

export class ConfigWriteResultDto {
  @ApiProperty({
    example: 'Accepted',
    description: 'Accepted, Rejected, RebootRequired, NotSupported…',
  })
  status: string;
}

export class ReserveDto {
  @ApiProperty({ default: 1 })
  @IsInt()
  @Min(1)
  evseId: number;

  @ApiProperty({ description: 'The RFID card the connector is held for' })
  @IsUUID('all', { message: 'Choose a card.' })
  idTokenId: string;

  @ApiProperty({ example: 30 })
  @IsInt()
  @Min(5, { message: 'Hold it for at least 5 minutes.' })
  @Max(240, { message: 'Hold it for at most 4 hours.' })
  minutes: number;
}

export class ReserveResultDto {
  @ApiProperty({ enum: ['ACTIVE', 'REJECTED'] }) status: string;
  @ApiProperty() title: string;
  @ApiProperty() detail: string;
}

export class LocalListResultDto {
  @ApiProperty({ example: 'Accepted' }) status: string;
  @ApiProperty() version: number;
  @ApiProperty({ description: 'Cards in the list' }) entries: number;
}

export class IdTokenDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: '04:A2:1C:9F' }) uid: string;
  @ApiProperty({ type: String, nullable: true, example: 'Tunde Bakare' })
  holder: string | null;
}
