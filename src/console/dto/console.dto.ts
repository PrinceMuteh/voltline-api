import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';

class MeUserDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() email: string;
}

class MeWorkspaceDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ example: 'NGN' }) currency: string;
  @ApiProperty({ example: 'Africa/Lagos' }) timeZone: string;
}

export class MeDto {
  @ApiProperty({ type: MeUserDto }) user: MeUserDto;
  @ApiProperty({ enum: Role, enumName: 'Role' }) role: Role;
  @ApiProperty({ type: MeWorkspaceDto }) workspace: MeWorkspaceDto;
}

class OnboardingStepDto {
  @ApiProperty({ enum: ['workspace', 'charger', 'tariff', 'gateway'] })
  key: string;
  @ApiProperty() label: string;
  @ApiProperty() done: boolean;
}

export class OnboardingDto {
  @ApiProperty({ type: [OnboardingStepDto] }) steps: OnboardingStepDto[];
  @ApiProperty() completed: number;
  @ApiProperty() total: number;
}

class ChargerCountsDto {
  @ApiProperty({ description: 'Approved chargers' }) total: number;
  @ApiProperty({ description: 'Approved and charging or available' })
  online: number;
  @ApiProperty() charging: number;
  @ApiProperty() available: number;
  @ApiProperty() reserved: number;
  @ApiProperty() faulted: number;
  @ApiProperty() offline: number;
  @ApiProperty() unavailable: number;
  @ApiProperty({ description: 'Waiting for approval' }) pending: number;
}

export class OverviewDto {
  @ApiProperty({ type: ChargerCountsDto }) chargers: ChargerCountsDto;
  @ApiProperty({ description: 'Connectors charging right now' })
  activeSessions: number;
  @ApiProperty({ description: 'Watts drawn right now' }) powerW: number;
  @ApiProperty() energyTodayWh: number;
  @ApiProperty() revenueTodayKobo: number;
  @ApiProperty({
    type: 'array',
    items: { type: 'number', nullable: true },
    description:
      'Wh delivered per local hour today, 24 entries; null for hours still to come',
  })
  energyByHourWh: (number | null)[];
}
