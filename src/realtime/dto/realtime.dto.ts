import { ApiProperty } from '@nestjs/swagger';

export class RealtimeTicketDto {
  @ApiProperty() ticket: string;
}
