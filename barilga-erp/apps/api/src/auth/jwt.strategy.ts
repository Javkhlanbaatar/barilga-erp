import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Role } from '@prisma/client';
import { isTopRole } from '../inventory/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './jwt-payload';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @Inject(ConfigService) config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { managedWarehouses: { select: { warehouseId: true } } },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException();
    }
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      name: user.fullName,
      fullName: user.fullName,
      warehouseId: user.warehouseId,
      warehouseIds: await this.warehouseIds(user.role, user.warehouseId, user.managedWarehouses.map((m) => m.warehouseId)),
    };
  }

  /**
   * The warehouses this person works in (null = all). A branch manager: home + assigned ones. Anyone else
   * below the general manager: their home warehouse, or the default warehouse when none is assigned — so an
   * unassigned cashier sells from and sees the default shop only, never every shop.
   */
  private async warehouseIds(role: Role, home: string | null, managed: string[]): Promise<string[] | null> {
    if (isTopRole(role)) return null;
    const ids = [...new Set([...(home ? [home] : []), ...(role === Role.MANAGER ? managed : [])])];
    if (ids.length) return ids;
    const def = await this.prisma.warehouse.findFirst({ where: { isDefault: true }, select: { id: true } });
    return def ? [def.id] : [];
  }
}
