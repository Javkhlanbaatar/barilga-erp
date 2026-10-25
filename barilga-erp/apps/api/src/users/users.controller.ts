import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateUserDto, UpdateUserDto, UpdateUserStatusDto, UserPermissionsDto } from './dto/upsert-user.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: { id: string }) {
    return this.users.create(dto, actor.id);
  }

  @Patch(':id/status')
  setStatus(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() actor: { id: string },
  ) {
    return this.users.setActive(id, dto.isActive, actor.id);
  }

  /** Rights added to or taken from this person: { grant: [...], revoke: [...] } (keys from GET /auth/permissions). */
  @Patch(':id/permissions')
  setPermissions(@Param('id') id: string, @Body() dto: UserPermissionsDto, @CurrentUser() actor: { id: string }) {
    return this.users.setPermissions(id, dto, actor.id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: { id: string }) {
    return this.users.update(id, dto, actor.id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() actor: { id: string }) {
    return this.users.deactivate(id, actor.id);
  }
}
