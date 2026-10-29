import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ChargerCountBand } from '../../generated/prisma/enums.js';

export const COUNTRIES = ['NG', 'GH', 'KE', 'ZA', 'OTHER'] as const;

export class SignUpDto {
  @ApiProperty({ example: 'Bola Ojo' })
  @IsString()
  @MinLength(2, { message: 'Enter your name.' })
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'Flex Mobility Limited' })
  @IsString()
  @MinLength(2, { message: 'Enter your company name.' })
  @MaxLength(160)
  company: string;

  @ApiProperty({ example: 'bola@flexmobility.co' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Enter an email address like name@company.com.' })
  email: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10, { message: 'Use at least 10 characters for your password.' })
  @MaxLength(200)
  password: string;

  @ApiProperty({ enum: COUNTRIES })
  @IsIn(COUNTRIES, { message: 'Choose a country of operation.' })
  country: (typeof COUNTRIES)[number];

  @ApiProperty({ enum: ChargerCountBand })
  @IsEnum(ChargerCountBand, {
    message: 'Choose how many chargers you will connect.',
  })
  chargerCount: ChargerCountBand;
}
