import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { RateLimit, RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto, CurrentPasswordDto, GoogleCredentialDto, GoogleLinkDto, UpdateProfileDto } from './dto/account.dto';
import { AuthUser } from './current-user.decorator';
import { effectivePermissions, PERMISSION_KEYS, PERMISSIONS } from './permissions';

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

  /** Before signing in: whether «Google-ээр нэвтрэх» is offered (and its public client id). */
  @Get('config')
  config() {
    return this.auth.publicConfig();
  }

  /** Sign in with the ID token Google Identity Services gave the page. Only already registered people. */
  @Post('google')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'login-google', limit: 60, windowMs: 15 * 60_000 })
  google(@Body() dto: GoogleCredentialDto) {
    return this.auth.googleLogin(dto.credential);
  }

  /** «Миний бүртгэл». */
  @Get('profile')
  @UseGuards(JwtAuthGuard)
  profile(@CurrentUser() user: AuthUser) {
    return this.auth.profile(user);
  }

  @Patch('profile')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ name: 'profile', limit: 30, windowMs: 15 * 60_000 })
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(user, dto);
  }

  /** Own password; other devices are signed out, this one gets a new token. */
  @Post('password')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ name: 'password', limit: 20, windowMs: 15 * 60_000 })
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user, dto.currentPassword, dto.newPassword);
  }

  /** Signs out every other device (password asked); this one gets a new token. */
  @Post('logout-all')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ name: 'logout-all', limit: 10, windowMs: 15 * 60_000 })
  logoutAll(@CurrentUser() user: AuthUser, @Body() dto: CurrentPasswordDto) {
    return this.auth.logoutAll(user, dto.currentPassword);
  }

  @Post('google/link')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ name: 'google-link', limit: 20, windowMs: 15 * 60_000 })
  linkGoogle(@CurrentUser() user: AuthUser, @Body() dto: GoogleLinkDto) {
    return this.auth.linkGoogle(user, dto.credential, dto.currentPassword);
  }

  /** Takes the Google account off (password asked); other sessions end, this one gets a new token. */
  @Post('google/unlink')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ name: 'google-unlink', limit: 10, windowMs: 15 * 60_000 })
  unlinkGoogle(@CurrentUser() user: AuthUser, @Body() dto: CurrentPasswordDto) {
    return this.auth.unlinkGoogle(user, dto.currentPassword);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    const { permissions: _overrides, ...rest } = user;
    return { ...rest, can: effectivePermissions(user) };
  }

  /** The list of rights the admin can give or take, with each role's default. */
  @Get('permissions')
  @UseGuards(JwtAuthGuard)
  permissions() {
    return PERMISSION_KEYS.map((key) => ({ key, ...PERMISSIONS[key] }));
  }
}
