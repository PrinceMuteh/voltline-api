import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SessionStatus } from '../../generated/prisma/enums.js';

export const RANGES = ['today', '7d', '30d', 'month'] as const;
export type Range = (typeof RANGES)[number];
export const FILTERS = ['all', 'active', 'completed', 'issues'] as const;
export type Filter = (typeof FILTERS)[number];

export class SessionsQueryDto {
  @ApiPropertyOptional({ enum: RANGES, description: 'Defaults to 7d' })
  @IsOptional()
  @IsIn(RANGES)
  range?: Range;

  @ApiPropertyOptional({ enum: FILTERS, description: 'Defaults to all' })
  @IsOptional()
  @IsIn(FILTERS)
  status?: Filter;

  @ApiPropertyOptional({ description: 'Session, driver, charger or card' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(80)
  q?: string;
}

class TotalsDto {
  @ApiProperty() sessions: number;
  @ApiProperty() energyWh: number;
  @ApiProperty({ description: 'Completed, faulted and failed sessions' })
  billedKobo: number;
  @ApiProperty({ description: 'Stopped by fault or payment failed' })
  needsReview: number;
}

class FilterCountsDto {
  @ApiProperty() all: number;
  @ApiProperty() active: number;
  @ApiProperty() completed: number;
  @ApiProperty() issues: number;
}

export class SessionRowDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'S-10482' }) reference: string;
  @ApiProperty({ example: 'Adaeze O.' }) driver: string;
  @ApiProperty() chargerId: string;
  @ApiProperty({ example: 'CP-0021' }) chargePointId: string;
  @ApiProperty({ example: 'Airport Road Hub' }) siteName: string;
  @ApiProperty({ format: 'date-time' }) startedAt: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  endedAt: string | null;
  @ApiProperty() energyWh: number;
  @ApiProperty({
    description: 'Final for ended sessions, a running estimate while active',
  })
  amountKobo: number;
  @ApiProperty({ enum: SessionStatus, enumName: 'SessionStatus' })
  status: SessionStatus;
}

export class SessionListDto {
  @ApiProperty({ type: TotalsDto }) totals: TotalsDto;
  @ApiProperty({ type: FilterCountsDto }) counts: FilterCountsDto;
  @ApiProperty({ type: [SessionRowDto] }) rows: SessionRowDto[];
  @ApiProperty({ description: 'Rows are capped; true when more matched' })
  truncated: boolean;
}

class PowerPointDto {
  @ApiProperty({ format: 'date-time' }) at: string;
  @ApiProperty() powerW: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Battery %, when the car reports it',
  })
  socPct: number | null;
}

class TimelineEntryDto {
  @ApiProperty({ format: 'date-time' }) at: string;
  @ApiProperty({ example: 'Charging started' }) label: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'TransactionEvent · Started',
  })
  detail: string | null;
}

class BillingDto {
  @ApiProperty() energyKobo: number;
  @ApiProperty() peakKobo: number;
  @ApiProperty() timeKobo: number;
  @ApiProperty() sessionFeeKobo: number;
  @ApiProperty() idleMinutes: number;
  @ApiProperty() idleKobo: number;
  @ApiProperty() vatKobo: number;
  @ApiProperty() totalKobo: number;
  @ApiProperty({ type: Number, nullable: true }) effectivePerKwhKobo:
    number | null;
  @ApiProperty() atPeak: boolean;
  @ApiProperty() vatIncluded: boolean;
  @ApiProperty() stoppedByFault: boolean;
  @ApiProperty({ description: 'False while the session is still running' })
  final: boolean;
}

class SessionTariffDto {
  @ApiProperty() name: string;
  @ApiProperty() version: number;
  @ApiProperty() perKwhKobo: number;
  @ApiProperty() vatBps: number;
  @ApiProperty({ type: Number, nullable: true }) peakSurchargeBps:
    number | null;
}

class IssueDto {
  @ApiProperty({ enum: ['fault', 'payment'] }) kind: string;
  @ApiProperty() title: string;
  @ApiProperty() text: string;
}

export class SessionDetailDto extends SessionRowDto {
  @ApiProperty({ type: String, nullable: true }) stopReason: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  chargingEndedAt: string | null;
  @ApiProperty({ type: IssueDto, nullable: true }) issue: IssueDto | null;
  @ApiProperty({ type: [PowerPointDto] }) power: PowerPointDto[];
  @ApiProperty() peakPowerW: number;
  @ApiProperty({ type: [TimelineEntryDto] }) timeline: TimelineEntryDto[];
  @ApiProperty({ type: BillingDto, nullable: true }) billing: BillingDto | null;
  @ApiProperty({ type: SessionTariffDto, nullable: true })
  tariff: SessionTariffDto | null;
  @ApiProperty({
    example: 'Wallet',
    description: 'Wallet, Prepaid account or Fleet invoice',
  })
  paymentMethod: string;
  @ApiProperty({ type: String, nullable: true }) siteAddress: string | null;
  @ApiProperty() workspaceName: string;
  @ApiProperty({ type: String, nullable: true }) registeredCompanyName:
    string | null;
}
