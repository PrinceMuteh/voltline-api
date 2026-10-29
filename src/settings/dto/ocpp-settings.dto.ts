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
  @ApiProperty() @IsBoolean() accept16J: boolean;
  @ApiProperty() @IsBoolean() accept201: boolean;
  @ApiProperty() @IsBoolean() autoApproveChargers: boolean;
  @ApiProperty() @IsBoolean() syncLocalLists: boolean;

  @ApiProperty({ minimum: 30, maximum: 3600 })
  @IsInt({ message: 'Heartbeat interval is whole seconds.' })
  @Min(30)
  @Max(3600)
  heartbeatIntervalSec: number;

  @ApiProperty({ minimum: 10, maximum: 900 })
  @IsInt({ message: 'Meter interval is whole seconds.' })
  @Min(10)
  @Max(900)
  meterValuesSampleSec: number;

  @ApiProperty({ minimum: 2, maximum: 240 })
  @IsInt({ message: 'Offline alert delay is whole minutes.' })
  @Min(2)
  @Max(240)
  offlineAlertAfterMin: number;
}

export class OcppSettingsUpdateDto extends PartialType(OcppSettingsInputDto) {}
