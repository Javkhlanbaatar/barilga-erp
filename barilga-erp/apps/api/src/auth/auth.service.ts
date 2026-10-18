import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { effectivePermissions, PermissionOverrides } from './permissions';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';

/** A bcrypt hash of a random string; compared against when the user does not exist. */
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), 10);

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
/** Wrong passwords in a row per username (in memory, per process); a success clears it. */
const failures = new Map<string, { count: number; until: number }>();

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const ident = (dto.username || dto.email || '').trim().toLowerCase();
    if (!ident) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const user = await this.prisma.user.findFirst({
      where: ident.includes('@')
        ? { email: ident }
        : { OR: [{ username: ident }, { email: ident }] },
    });
    const f = failures.get(ident);
    if (f && f.count >= MAX_FAILURES && f.until > Date.now()) {
      throw new UnauthorizedException('Олон удаа буруу оруулсан тул 15 минут түр хаагдлаа / Too many attempts, try again later');
    }
    // Always run one bcrypt comparison, so the response time does not reveal whether the username exists.
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.isActive || !ok) {
      const count = (f && f.until > Date.now() ? f.count : 0) + 1;
      if (failures.size > 10_000) for (const [k, v] of failures) if (v.until <= Date.now()) failures.delete(k);
      failures.set(ident, { count, until: Date.now() + LOCK_MS });
      throw new UnauthorizedException('Invalid credentials');
    }
    failures.delete(ident);
    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    });
    return {
      accessToken: token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.fullName,
        fullName: user.fullName,
        role: user.role,
        isActive: user.isActive,
        warehouseId: user.warehouseId,
        // Rights in force now (role + what the admin changed for this person), for showing the right buttons.
        can: effectivePermissions({ role: user.role, permissions: user.permissions as PermissionOverrides }),
      },
    };
  }
}
