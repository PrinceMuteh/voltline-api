import { Controller, Get } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, type AuthContext } from '../auth/auth.decorators.js';
import { ConsoleService } from './console.service.js';
import { MeDto, OnboardingDto, OverviewDto } from './dto/console.dto.js';

@ApiTags('console')
@ApiCookieAuth()
@Controller('console')
export class ConsoleController {
  constructor(private readonly console: ConsoleService) {}

  @Get('me')
  @ApiOkResponse({ type: MeDto })
  me(@CurrentAuth() auth: AuthContext) {
    return this.console.me(auth);
  }

  @Get('onboarding')
  @ApiOkResponse({ type: OnboardingDto })
  onboarding(@CurrentAuth() auth: AuthContext) {
    return this.console.onboarding(auth);
  }

  @Get('overview')
  @ApiOkResponse({ type: OverviewDto })
  overview(@CurrentAuth() auth: AuthContext) {
    return this.console.overview(auth);
  }
}
