import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class DriversQueryDto {
  @ApiPropertyOptional({ description: 'Name, phone or card UID' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  q?: string;
}

export class FleetSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'GreenRide fleet' }) name: string;
  @ApiProperty({ description: 'Active cards held by the fleet' }) cards: number;
  @ApiProperty({ description: 'Billed this month, in kobo' })
  monthKobo: number;
  @ApiProperty({ description: 'Day of the month the fleet is invoiced' })
  invoiceDay: number;
}

export class DriverRowDto {
  @ApiProperty() id: string;
  @ApiProperty({ type: String, nullable: true, example: 'Adaeze Okafor' })
  name: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '+234 803 ••• 4412',
    description: 'Masked; null for fleet vehicles',
  })
  phone: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'GreenRide fleet' })
  fleet: string | null;
  @ApiProperty({ description: 'Signed in to the driver app' }) app: boolean;
  @ApiProperty({ type: [String], example: ['04:A2:1C:9F'] }) cards: string[];
  @ApiProperty() sessions: number;
  @ApiProperty({ enum: ['WALLET', 'PREPAID', 'INVOICE'] })
  billing: 'WALLET' | 'PREPAID' | 'INVOICE';
  @ApiProperty({ type: Number, nullable: true, example: 1850000 })
  walletKobo: number | null;
  @ApiProperty({ enum: ['ACTIVE', 'BLOCKED', 'PAYMENT_OVERDUE'] })
  status: 'ACTIVE' | 'BLOCKED' | 'PAYMENT_OVERDUE';
}

export class DriversPageDto {
  @ApiProperty({ description: 'Drivers with a session this month' })
  activeThisMonth: number;
  @ApiProperty({ description: 'Active RFID cards' }) cardsIssued: number;
  @ApiProperty({ type: [FleetSummaryDto] }) fleets: FleetSummaryDto[];
  @ApiProperty({ type: [DriverRowDto] }) drivers: DriverRowDto[];
}

export class DriverStatusResultDto {
  @ApiProperty({ type: DriverRowDto }) driver: DriverRowDto;
  @ApiProperty({ description: 'Connected chargers being sent the new list' })
  syncing: number;
}

export class IssueCardDto {
  @ApiProperty({ example: '04:E3:5A:71' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .replace(/[\s:-]/g, '')
          .toUpperCase()
          .match(/.{1,2}/g)
          ?.join(':')
      : value,
  )
  @IsString()
  @Matches(/^([0-9A-F]{2}:){3,9}[0-9A-F]{2}$/, {
    message: 'Card UIDs are 4 to 10 hex bytes, like 04:A2:1C:9F.',
  })
  uid: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsUUID()
  driverId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsUUID()
  fleetId?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 2000000 })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  dailyLimitKobo?: number | null;
}

export class IssuedCardDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: '04:E3:5A:71' }) uid: string;
  @ApiProperty({ type: String, nullable: true, example: 'Adaeze Okafor' })
  holder: string | null;
  @ApiProperty({ description: 'Connected chargers being sent the new list' })
  syncing: number;
}

export class FleetInputDto {
  @ApiProperty({ example: 'GreenRide fleet' })
  @Transform(trim)
  @IsString()
  @Length(2, 80, { message: 'Fleet names are 2 to 80 characters.' })
  name: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28, { message: 'Pick a day from 1 to 28.' })
  invoiceDay?: number;
}

export class ReadCardResultDto {
  @ApiProperty({ example: '04:E3:5A:71' }) uid: string;
  @ApiProperty({ description: 'Already issued in this workspace' })
  known: boolean;
}
