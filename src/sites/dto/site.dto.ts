import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class SiteDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'Wuse II Mall' }) name: string;
  @ApiProperty({ type: String, nullable: true, example: 'Wuse II, Abuja' })
  area: string | null;
  @ApiProperty({ type: String, nullable: true }) address: string | null;
  @ApiProperty({ type: Number, nullable: true, example: 9.0765 })
  latitude: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 7.4886 })
  longitude: number | null;
  @ApiProperty({ example: 'Open 24 hours' }) openingHours: string;
  @ApiProperty({ type: Number, nullable: true, example: 250 })
  gridLimitKw: number | null;
  @ApiProperty() chargerCount: number;
}

export class SiteInputDto {
  @ApiProperty({ example: 'Ikeja City Mall' })
  @Transform(trim)
  @IsString()
  @Length(2, 80, { message: 'Site names are 2 to 80 characters.' })
  name: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Ikeja, Lagos',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  area?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  address?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsNumber({}, { message: 'Latitude is a number between -90 and 90.' })
  @Min(-90)
  @Max(90)
  latitude?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsNumber({}, { message: 'Longitude is a number between -180 and 180.' })
  @Min(-180)
  @Max(180)
  longitude?: number | null;

  @ApiPropertyOptional({ example: 'Open 24 hours' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  openingHours?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 250 })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt({ message: 'Enter the grid limit as whole kW.' })
  @Min(1)
  @Max(100_000)
  gridLimitKw?: number | null;
}

export class SiteUpdateDto extends PartialType(SiteInputDto) {}
