import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class SignInDto {
  @ApiProperty({ example: 'bola@flexmobility.co' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Enter an email address like name@company.com.' })
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(1, { message: 'Enter your password.' })
  password: string;
}
