import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CurrentAuth,
  Roles,
  type AuthContext,
} from '../auth/auth.decorators.js';
import {
  PreviewDto,
  PreviewResultDto,
  TariffDto,
  TariffInputDto,
} from './dto/tariff.dto.js';
import { TariffsService } from './tariffs.service.js';

@ApiTags('console')
@ApiCookieAuth()
@Controller('console/tariffs')
export class TariffsController {
  constructor(private readonly tariffs: TariffsService) {}

  @Get()
  @ApiOkResponse({ type: [TariffDto] })
  list(@CurrentAuth() auth: AuthContext) {
    return this.tariffs.list(auth);
  }

  @Post()
  @Roles('ADMIN')
  @ApiCreatedResponse({ type: TariffDto })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: TariffInputDto) {
    return this.tariffs.create(auth, dto);
  }

  /** Full replace of the editable fields; may return a new version with a new id. */
  @Put(':id')
  @Roles('ADMIN')
  @ApiOkResponse({ type: TariffDto })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TariffInputDto,
  ) {
    return this.tariffs.update(auth, id, dto);
  }

  @Post('preview')
  @HttpCode(200)
  @ApiOkResponse({ type: PreviewResultDto })
  preview(@Body() dto: PreviewDto) {
    return this.tariffs.preview(dto);
  }
}
