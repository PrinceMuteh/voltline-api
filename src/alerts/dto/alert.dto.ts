import { ApiProperty } from '@nestjs/swagger';
import { AlertType } from '../../generated/prisma/enums.js';

export class AlertDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: AlertType, enumName: 'AlertType' }) type: AlertType;
  @ApiProperty({ example: 'CP-0031 faulted' }) title: string;
  @ApiProperty({ example: 'GroundFailure · Lekki Phase 1' }) detail: string;
  @ApiProperty({ type: String, nullable: true }) chargerId: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'CP-0031' })
  chargePointId: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}
