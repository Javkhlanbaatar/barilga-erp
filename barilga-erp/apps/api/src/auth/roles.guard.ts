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
import { can, PERMISSION_KEY_META, PermissionOverrides, PermissionRule, PERMISSIONS } from './permissions';
import { roleAllowed } from './rbac';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly log = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user as { id?: string; role?: Role; email?: string; permissions?: PermissionOverrides } | undefined;

    // A right (@Permission) takes the place of the role list: the role's default, changed per person by the admin.
    const rule = this.reflector.getAllAndOverride<PermissionRule | undefined>(PERMISSION_KEY_META, [context.getHandler(), context.getClass()]);
    if (rule) {
      const permission = rule.key;
      if (!user?.role) throw new UnauthorizedException('Missing authenticated user');
      if (!can({ role: user.role, permissions: user.permissions }, permission) && !roleAllowed(user.role, rule.alsoRoles)) {
        this.log.warn(`Permission deny ${user.email ?? user.id} role=${user.role} need=${permission} ${req.method} ${req.url}`);
        throw new ForbiddenException(`Танд «${PERMISSIONS[permission].label}» эрх байхгүй / Permission ${permission} is required`);
      }
      return true;
    }

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    if (!user?.role) {
      throw new UnauthorizedException('Missing authenticated user');
    }
    if (!roleAllowed(user.role, required)) {
      this.log.warn(
        `RBAC deny ${user.email ?? user.id} role=${user.role} need=${required.join('|')} ${req.method} ${req.url}`,
      );
      throw new ForbiddenException(`Role ${user.role} is not allowed to perform this action`);
    }
    return true;
  }
}
