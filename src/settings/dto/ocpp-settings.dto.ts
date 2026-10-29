import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsInt, Max, Min } from 'class-validator';

export class OcppSettingsDto {
  @ApiProperty() accept16J: boolean;
  @ApiProperty() accept201: boolean;
  @ApiProperty({
    description: 'Not supported by the gateway yet; always false',
  })
  accept21: boolean;
  @ApiProperty() autoApproveChargers: boolean;
  @ApiProperty() syncLocalLists: boolean;
  @ApiProperty({ example: 300 }) heartbeatIntervalSec: number;
  @ApiProperty({ example: 60 }) meterValuesSampleSec: number;
  @ApiProperty({ example: 10 }) offlineAlertAfterMin: number;
  @ApiProperty({ example: 'ws://localhost:4000/ocpp/{chargePointId}' })
  endpoint: string;
}

export class OcppSettingsInputDto {
  @IsBoolean() accept16J: boolean;
  @IsBoolean() accept201: boolean;
  @IsBoolean() autoApproveChargers: boolean;
  @IsBoolean() syncLocalLists: boolean;

  @IsInt({ message: 'Heartbeat interval is whole seconds.' })
  @Min(30)
  @Max(3600)
  heartbeatIntervalSec: number;

  @IsInt({ message: 'Meter interval is whole seconds.' })
  @Min(10)
  @Max(900)
  meterValuesSampleSec: number;

  @IsInt({ message: 'Offline alert delay is whole minutes.' })
  @Min(2)
  @Max(240)
  offlineAlertAfterMin: number;
}

export class OcppSettingsUpdateDto extends PartialType(OcppSettingsInputDto) {}
