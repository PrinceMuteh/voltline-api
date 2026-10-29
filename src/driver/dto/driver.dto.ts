import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { ConnectorType, SessionStatus } from '../../generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// ─── Sign-in ─────────────────────────────────────────────────────────────────

export class SendCodeDto {
  @ApiProperty({ example: '803 000 0000' })
  @IsString()
  @Length(7, 20)
  phone: string;
}

export class SentCodeDto {
  @ApiProperty({ example: '+2348030000000' }) phone: string;
  @ApiPropertyOptional({
    description: 'Only outside production, while no SMS provider is set up',
  })
  devCode?: string;
}

export class VerifyCodeDto {
  @ApiProperty({ example: '803 000 0000' })
  @IsString()
  @Length(7, 20)
  phone: string;

  @ApiProperty({ example: '123456' })
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code.' })
  code: string;
}

export class VerifiedDto {
  @ApiProperty({ description: 'First sign-in: show plug and location set-up' })
  isNew: boolean;
}

// ─── Profile ─────────────────────────────────────────────────────────────────

export class DriverMeDto {
  @ApiProperty() id: string;
  @ApiProperty({ type: String, nullable: true }) name: string | null;
  @ApiProperty({ example: '+2348030000000' }) phone: string;
  @ApiProperty({
    enum: ConnectorType,
    enumName: 'ConnectorType',
    isArray: true,
  })
  plugTypes: ConnectorType[];
  @ApiProperty({ type: Number, nullable: true, example: 1500000 })
  autoStopKobo: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Null: no wallet yet',
  })
  walletKobo: number | null;
  @ApiProperty({ type: [String], example: ['04:A2:1C:9F'] }) cards: string[];
  @ApiProperty({ example: 'Voltline Demo' }) operator: string;
}

export class UpdateDriverDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  name?: string;

  @ApiPropertyOptional({
    enum: ConnectorType,
    enumName: 'ConnectorType',
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Choose at least one plug.' })
  @IsEnum(ConnectorType, { each: true })
  plugTypes?: ConnectorType[];

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Kobo; null for no limit',
  })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(100_000, { message: 'The auto-stop budget is at least ₦1,000.' })
  @Max(50_000_000)
  autoStopKobo?: number | null;
}

export class LinkCardDto {
  @ApiProperty({ example: '04:A2:1C:9F', description: 'Printed on the card' })
  @Transform(trim)
  @Matches(/^[0-9A-Fa-f]{2}(:?[0-9A-Fa-f]{2}){3,9}$/, {
    message: 'Enter the card number printed on the back, like 04:A2:1C:9F.',
  })
  uid: string;
}

// ─── Stations ────────────────────────────────────────────────────────────────

class StationConnectorDto {
  @ApiProperty() chargerId: string;
  @ApiProperty({ example: 'CP-0021' }) chargePointId: string;
  @ApiProperty() evseId: number;
  @ApiProperty({ enum: ConnectorType, enumName: 'ConnectorType' })
  type: ConnectorType;
  @ApiProperty({ example: 120 }) maxKw: number;
  @ApiProperty({
    enum: [
      'AVAILABLE',
      'RESERVED',
      'CHARGING',
      'FAULTED',
      'UNAVAILABLE',
      'OFFLINE',
    ],
  })
  status: string;
}

class StationPriceDto {
  @ApiProperty({ example: 'Standard DC' }) name: string;
  @ApiProperty({ example: 30000 }) perKwhKobo: number;
  @ApiProperty() sessionFeeKobo: number;
  @ApiProperty({ type: Number, nullable: true }) idleGraceMin: number | null;
  @ApiProperty({ type: Number, nullable: true }) idlePerMinuteKobo:
    number | null;
  @ApiProperty({ type: String, nullable: true }) peakFrom: string | null;
  @ApiProperty({ type: String, nullable: true }) peakTo: string | null;
  @ApiProperty({ type: Number, nullable: true }) peakSurchargeBps:
    number | null;
}

export class StationDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'Airport Road Hub' }) name: string;
  @ApiProperty({ type: String, nullable: true }) area: string | null;
  @ApiProperty({ type: String, nullable: true }) address: string | null;
  @ApiProperty({ type: Number, nullable: true }) latitude: number | null;
  @ApiProperty({ type: Number, nullable: true }) longitude: number | null;
  @ApiProperty({ example: 'Open 24 hours' }) openingHours: string;
  @ApiProperty({ example: 120 }) maxKw: number;
  @ApiProperty({ description: 'Connectors free right now' }) free: number;
  @ApiProperty({ description: 'Every charger here is offline' })
  offline: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Minutes since the site was last heard from, when offline',
  })
  offlineMinutes: number | null;
  @ApiProperty({ type: StationPriceDto, nullable: true }) price: StationPriceDto | null;
  @ApiProperty({ type: [StationConnectorDto] }) connectors: StationConnectorDto[];
}

// ─── Charging ────────────────────────────────────────────────────────────────

export class StartDto {
  @ApiProperty() @IsUUID() chargerId: string;
  @ApiProperty() @IsInt() @Min(1) evseId: number;
}

export class StartResultDto {
  @ApiProperty({ enum: ['ACCEPTED', 'REJECTED', 'NO_RESPONSE', 'OFFLINE'] })
  outcome: string;
  @ApiProperty() title: string;
  @ApiProperty() message: string;
}

export class LiveSessionDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'S-10482' }) reference: string;
  @ApiProperty({ enum: SessionStatus, enumName: 'SessionStatus' })
  status: SessionStatus;
  @ApiProperty() stationName: string;
  @ApiProperty() chargePointId: string;
  @ApiProperty() evseId: number;
  @ApiProperty({
    enum: ConnectorType,
    enumName: 'ConnectorType',
    nullable: true,
  })
  connectorType: ConnectorType | null;
  @ApiProperty({ format: 'date-time' }) startedAt: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) endedAt:
    string | null;
  @ApiProperty() energyWh: number;
  @ApiProperty({ type: Number, nullable: true }) powerW: number | null;
  @ApiProperty({ type: Number, nullable: true }) socPct: number | null;
  @ApiProperty({ description: 'So far while active; final once ended' })
  costKobo: number;
  @ApiProperty({ type: Number, nullable: true }) autoStopKobo: number | null;
  @ApiProperty({
    description: 'The car has stopped drawing power (idle time may be billed)',
  })
  idle: boolean;
}

export class LiveDto {
  @ApiProperty({
    type: LiveSessionDto,
    nullable: true,
    description: 'Null when nothing is running',
  })
  session: LiveSessionDto | null;
}

export class HistoryItemDto {
  @ApiProperty() id: string;
  @ApiProperty() reference: string;
  @ApiProperty() stationName: string;
  @ApiProperty({
    enum: ConnectorType,
    enumName: 'ConnectorType',
    nullable: true,
  })
  connectorType: ConnectorType | null;
  @ApiProperty({ format: 'date-time' }) startedAt: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) endedAt:
    string | null;
  @ApiProperty() energyWh: number;
  @ApiProperty() amountKobo: number;
  @ApiProperty({ enum: SessionStatus, enumName: 'SessionStatus' })
  status: SessionStatus;
}

export class HistoryDto {
  @ApiProperty({ example: 'October' }) month: string;
  @ApiProperty() monthEnergyWh: number;
  @ApiProperty() monthAmountKobo: number;
  @ApiProperty({ type: [HistoryItemDto] }) sessions: HistoryItemDto[];
}
