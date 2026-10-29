import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_MESSAGE = 'Enter a time like 18:00.';

/** The price fields, shared by the editor and the preview. Money in kobo. */
export class TariffRatesDto {
  @ApiProperty({ example: 30000 })
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  perKwhKobo: number;

  @ApiProperty({ example: 0 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  perMinuteKobo: number;

  @ApiProperty({ example: 20000 })
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  sessionFeeKobo: number;

  @ApiProperty({ type: Number, nullable: true, example: 15 })
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(240)
  idleGraceMin: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 5000,
    description: 'Null = no idle fee',
  })
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  idlePerMinuteKobo: number | null;

  @ApiProperty({ type: String, nullable: true, example: '18:00' })
  @ValidateIf((o: TariffRatesDto) => o.peakSurchargeBps !== null)
  @Matches(HHMM, { message: TIME_MESSAGE })
  peakFrom: string | null;

  @ApiProperty({ type: String, nullable: true, example: '22:00' })
  @ValidateIf((o: TariffRatesDto) => o.peakSurchargeBps !== null)
  @Matches(HHMM, { message: TIME_MESSAGE })
  peakTo: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1500,
    description: 'Null = no peak surcharge',
  })
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(10_000)
  peakSurchargeBps: number | null;

  @ApiProperty() @IsBoolean() vatIncluded: boolean;

  @ApiProperty({ example: 750 })
  @IsInt()
  @Min(0)
  @Max(5_000)
  vatBps: number;
}

export class TariffInputDto extends TariffRatesDto {
  @ApiProperty({ example: 'Standard DC' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(2, 60, { message: 'Tariff names are 2 to 60 characters.' })
  name: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsUUID('all', { each: true })
  siteIds: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Only this fleet pays this tariff',
  })
  @IsOptional()
  @IsUUID()
  fleetId?: string | null;
}

export class PreviewDto {
  @ApiProperty({ type: TariffRatesDto })
  @ValidateNested()
  @Type(() => TariffRatesDto)
  rates: TariffRatesDto;

  @ApiProperty({ example: 30 })
  @IsNumber()
  @Min(0)
  @Max(400)
  energyKwh: number;

  @ApiProperty({ example: 60 })
  @IsInt()
  @Min(0)
  @Max(1440)
  pluggedMinutes: number;

  @ApiProperty({ description: 'The session starts inside the peak window' })
  @IsBoolean()
  atPeak: boolean;
}

class NamedDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
}

export class TariffDto extends TariffRatesDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({
    description: 'Bumps when an edit changes prices of a tariff already used',
  })
  version: number;
  @ApiProperty({ type: [NamedDto] }) sites: NamedDto[];
  @ApiProperty({ type: NamedDto, nullable: true }) fleet: NamedDto | null;
  @ApiProperty({ description: 'Sessions priced by this version' })
  sessionCount: number;
}

export class PriceBreakdownDto {
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
}

export class PreviewResultDto {
  @ApiProperty({ description: 'At the preview’s steady 50 kW' })
  chargingMinutes: number;
  @ApiProperty({ type: PriceBreakdownDto }) breakdown: PriceBreakdownDto;
}
