import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { RateLimit, RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * 60 tries per 15 minutes per address (a whole shop logs in from one address); a single username is also
   * locked for 15 minutes after 5 wrong passwords in a row (AuthService).
   */
  @Post('login')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'login', limit: 60, windowMs: 15 * 60_000 })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: { id: string; email: string; role: string; name: string }) {
    return user;
  }
}
