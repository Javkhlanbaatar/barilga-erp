import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly log = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user as { id?: string; role?: Role; email?: string } | undefined;
    if (!user?.role) {
      throw new UnauthorizedException('Missing authenticated user');
    }
    if (!required.includes(user.role)) {
      this.log.warn(
        `RBAC deny ${user.email ?? user.id} role=${user.role} need=${required.join('|')} ${req.method} ${req.url}`,
      );
      throw new ForbiddenException(`Role ${user.role} is not allowed to perform this action`);
    }
    return true;
  }
}
