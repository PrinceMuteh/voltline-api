import { plainToInstance } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
  validateSync,
} from 'class-validator';

class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: string;

  @IsOptional()
  @IsInt()
  PORT?: number;

  @IsString()
  DATABASE_URL: string;

  @IsString()
  REDIS_URL: string;

  @IsUrl({ require_tld: false })
  WEB_ORIGIN: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET: string;

  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET: string;

  @IsInt()
  JWT_ACCESS_TTL_MIN: number;

  @IsInt()
  JWT_REFRESH_TTL_DAYS: number;

  @IsBooleanString()
  COOKIE_SECURE: string;

  /** What chargers are told to dial; the charge point ID is appended. */
  @IsOptional()
  @IsString()
  OCPP_PUBLIC_URL?: string;

  /** The workspace the driver app belongs to (one app per operator). */
  @IsOptional()
  @IsString()
  DRIVER_APP_WORKSPACE?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(
      `Invalid environment: ${errors.map((e) => Object.values(e.constraints ?? {}).join(', ')).join('; ')}`,
    );
  }
  return validated;
}
