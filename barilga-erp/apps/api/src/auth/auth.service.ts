import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { audit } from '../common/audit';
import { effectivePermissions, PermissionOverrides } from './permissions';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './current-user.decorator';
import { WEBSHOP_USERNAME } from './rbac';
import { UpdateProfileDto } from './dto/account.dto';
import { LoginDto } from './dto/login.dto';

/** A bcrypt hash of a random string; compared against when the user does not exist. */
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), 10);
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

/** Wrong passwords in a row per username (in memory, per process); a success clears it. */
const failures = new Map<string, { count: number; until: number }>();
/** Wrong current passwords on «Миний бүртгэл», per user id: kept apart, so sign-in attempts cannot set it. */
const ownFailures = new Map<string, { count: number; until: number }>();

/** What a verified Google sign-in tells us (from the ID token Google signed). `hd`: the Workspace domain, if any. */
export type GoogleIdentity = { sub: string; email: string | null; emailVerified: boolean; name: string | null; hd?: string | null };

/**
 * Google vouches for an address only for Gmail, or for a Workspace domain it reports as `hd` (Google's ID-token
 * guidance); any other address may have changed hands since the Google account was made.
 */
export function googleOwnsEmail(g: GoogleIdentity) {
  if (!g.email || !g.emailVerified) return false;
  const domain = g.email.split('@')[1] ?? '';
  return domain === 'gmail.com' || domain === 'googlemail.com' || (!!g.hd && g.hd.toLowerCase() === domain);
}

const NOT_LINKED =
  'Энэ Google бүртгэлээр нэвтрэх боломжгүй. Админаар Gmail хаягаа бүртгүүлэх, эсвэл нууц үгээр нэвтрээд «Миний бүртгэл»-ээс холбоно уу / This Google account cannot sign in here';

/**
 * The start of the current second: tokens carry their issue time in whole seconds, so a token made right after a
 * change (same second) still counts as issued after it.
 */
const sessionCutoff = () => new Date(Math.floor(Date.now() / 1000) * 1000);

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);
  private google?: OAuth2Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  /** The OAuth client id from Google Cloud (GOOGLE_CLIENT_ID); none = Google sign-in is off. Not a secret. */
  private googleClientId(): string | null {
    return this.configService?.get<string>('GOOGLE_CLIENT_ID')?.trim() || null;
  }

  /** What the login page needs to know before anyone signs in. */
  publicConfig() {
    return { googleClientId: this.googleClientId() };
  }

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
      this.countFailure(ident);
      throw new UnauthorizedException('Invalid credentials');
    }
    failures.delete(ident);
    return this.issue(user);
  }

  /** One more wrong password for this key, in its own map (sign-in and own-password locks never mix). */
  private countFailure(key: string, map: Map<string, { count: number; until: number }> = failures) {
    const f = map.get(key);
    const count = (f && f.until > Date.now() ? f.count : 0) + 1;
    if (map.size > 10_000) for (const [k, v] of map) if (v.until <= Date.now()) map.delete(k);
    map.set(key, { count, until: Date.now() + LOCK_MS });
  }

  /** A signed-in session: the token and what the pages show about the person. */
  private async issue(user: User) {
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

  /**
   * Checks a Google ID token the official way (google-auth-library: Google's signature, issuer, expiry, and that it
   * was made for this app's client id). Replaced in tests.
   */
  protected async verifyGoogle(credential: string): Promise<GoogleIdentity> {
    const clientId = this.googleClientId();
    if (!clientId) throw new BadRequestException('Google-ээр нэвтрэх тохируулагдаагүй байна / Google sign-in is not set up');
    // The issuers Google documents for ID tokens.
    this.google ??= new OAuth2Client({ issuers: ['accounts.google.com', 'https://accounts.google.com'] });
    const failed = () => new BadRequestException('Google-ийн баталгаажуулалт амжилтгүй — дахин оролдоно уу / Google sign-in could not be verified');
    let payload;
    try {
      const ticket = await this.google.verifyIdToken({ idToken: credential, audience: clientId });
      payload = ticket.getPayload();
    } catch (err) {
      // The kind of failure only: the library's message goes on with the token or its payload after the colon.
      const reason = (err instanceof Error ? err.message : String(err)).split(':')[0].replace(/[\r\n]+/g, ' ').slice(0, 120);
      this.log.warn(`Google ID token refused: ${reason}`);
      throw failed();
    }
    if (!payload?.sub) throw failed();
    return {
      sub: payload.sub,
      email: payload.email?.toLowerCase() ?? null,
      emailVerified: payload.email_verified === true,
      name: payload.name ?? null,
      hd: payload.hd ?? null,
    };
  }

  /**
   * Sign in with Google. Only people the admin registered, and only two ways: the Google account the person linked
   * on «Миний бүртгэл» (with their password), or the Gmail address the admin wrote on their user as «Google Gmail»
   * (linked on its first use; Google must vouch for the address). The ordinary e-mail is never used for this, and
   * nobody is created.
   */
  async googleLogin(credential: string) {
    const g = await this.verifyGoogle(credential);
    let user = await this.prisma.user.findUnique({ where: { googleSub: g.sub } });
    if (user && g.email && googleOwnsEmail(g) && g.email !== user.googleEmail) {
      // The Google account's address changed: show the current one, unless another person has it reserved.
      const taken = await this.prisma.user.findFirst({ where: { id: { not: user.id }, googleEmail: { equals: g.email, mode: 'insensitive' } }, select: { id: true } });
      if (!taken) user = await this.prisma.user.update({ where: { id: user.id }, data: { googleEmail: g.email } });
    }
    if (!user && googleOwnsEmail(g)) {
      const allowed = await this.prisma.user.findMany({ where: { googleEmail: { equals: g.email!, mode: 'insensitive' }, googleSub: null }, take: 2 });
      const [first] = allowed;
      if (allowed.length === 1 && first.isActive && first.username !== WEBSHOP_USERNAME) {
        // Only while the row is still as read (the admin may be changing its Google Gmail at this moment).
        const claimed = await this.prisma.user
          .updateMany({
            where: { id: first.id, googleSub: null, isActive: true, googleEmail: { equals: g.email!, mode: 'insensitive' } },
            data: { googleSub: g.sub, googleEmail: g.email },
          })
          .catch(() => ({ count: 0 }));
        if (claimed.count !== 1) throw new UnauthorizedException(NOT_LINKED);
        user = await this.prisma.user.findUniqueOrThrow({ where: { id: first.id } });
        await audit(this.prisma, {
          entityType: 'USER',
          entityId: user.id,
          summary: `${user.fullName} (${user.username}): админы бүртгэсэн Gmail ${g.email}-ээр анх нэвтэрч холбогдов`,
          actorId: user.id,
        });
      }
    }
    if (!user || !user.isActive || user.username === WEBSHOP_USERNAME) throw new UnauthorizedException(NOT_LINKED);
    this.log.log(`Google sign-in ${user.username} (${user.id})`);
    return this.issue(user);
  }

  /** «Миний бүртгэл»: what the person may see and change about themselves. */
  async profile(actor: AuthUser) {
    const u = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { id: true, username: true, fullName: true, email: true, phone: true, role: true, googleEmail: true, googleSub: true, warehouse: { select: { name: true } } },
    });
    if (!u) throw new NotFoundException('User not found');
    const { googleSub, warehouse, ...rest } = u;
    return { ...rest, warehouseName: warehouse?.name ?? null, googleLinked: Boolean(googleSub), googleEnabled: Boolean(this.googleClientId()) };
  }

  async updateProfile(actor: AuthUser, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!user) throw new NotFoundException('User not found');
    const email = dto.email === undefined ? undefined : dto.email || null;
    const emailChanges = email !== undefined && email !== (user.email ?? null);
    if (emailChanges) {
      // The e-mail signs in: changing it needs the password, like changing the password.
      await this.assertPassword(user, dto.currentPassword ?? '');
    }
    const data: Prisma.UserUpdateInput = {
      ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone || null } : {}),
      ...(emailChanges ? { email } : {}),
    };
    if (!Object.keys(data).length) return this.profile(actor);
    try {
      await this.prisma.user.update({ where: { id: user.id }, data });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Энэ имэйл өөр хэрэглэгчид бүртгэлтэй / This e-mail is already in use');
      }
      throw err;
    }
    const changed = [
      dto.fullName !== undefined && dto.fullName !== user.fullName ? 'нэр' : '',
      dto.phone !== undefined && (dto.phone || null) !== (user.phone ?? null) ? 'утас' : '',
      emailChanges ? 'имэйл' : '',
    ].filter(Boolean);
    if (changed.length) {
      await audit(this.prisma, {
        entityType: 'USER',
        entityId: user.id,
        summary: `${user.fullName} (${user.username}): өөрийн ${changed.join(', ')} засав`,
        before: { fullName: user.fullName, phone: user.phone, email: user.email },
        after: { fullName: dto.fullName ?? user.fullName, phone: dto.phone ?? user.phone, email: emailChanges ? email : user.email },
        actorId: user.id,
      });
    }
    return this.profile(actor);
  }

  /** The current password, with the same 5-tries lock as signing in. */
  private async assertPassword(user: User, password: string) {
    const key = user.id;
    const f = ownFailures.get(key);
    if (f && f.count >= MAX_FAILURES && f.until > Date.now()) {
      throw new BadRequestException('Олон удаа буруу оруулсан тул 15 минут түр хаагдлаа / Too many attempts, try again later');
    }
    if (!password || !(await bcrypt.compare(password, user.passwordHash))) {
      this.countFailure(key, ownFailures);
      throw new BadRequestException('Одоогийн нууц үг буруу / The current password is wrong');
    }
    ownFailures.delete(key);
  }

  /**
   * The person changes their own password. Every other signed-in device is signed out (its token stops working);
   * this one gets a new token.
   */
  async changePassword(actor: AuthUser, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!user || !user.isActive) throw new UnauthorizedException();
    await this.assertPassword(user, currentPassword);
    // bcrypt reads 72 bytes (a Cyrillic letter is 2): anything after would not count.
    if (Buffer.byteLength(newPassword, 'utf8') > 72) {
      throw new BadRequestException('Шинэ нууц үг хэт урт (кирилл үсгээр 36 орчим тэмдэгтээс ихгүй) / The new password is too long');
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw new BadRequestException('Шинэ нууц үг одоогийнхоос өөр байна / The new password must differ from the current one');
    }
    if (newPassword.toLowerCase() === user.username.toLowerCase()) {
      throw new BadRequestException('Нууц үг хэрэглэгчийн нэртэй адил байж болохгүй / The password must not equal the username');
    }
    // A new password is a reset of every way in: other devices are signed out and the Google link is taken off
    // (it may have been added by whoever knew the old password); the person links it again if it was theirs.
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 12), sessionsValidFrom: sessionCutoff(), googleSub: null, googleEmail: null },
    });
    await audit(this.prisma, {
      entityType: 'USER',
      entityId: user.id,
      summary:
        `${user.fullName} (${user.username}): нууц үгээ өөрөө сольсон (бусад төхөөрөмжөөс гаргав` +
        (user.googleSub || user.googleEmail ? `, Google ${user.googleEmail ?? ''} салгав)` : ')'),
      actorId: user.id,
    });
    return { ...(await this.issue(updated)), googleUnlinked: Boolean(user.googleSub || user.googleEmail) };
  }

  /**
   * Signs out every device (a lost phone, a shared computer); this one gets a new token. The password is asked, so a
   * stolen session cannot keep renewing itself this way.
   */
  async logoutAll(actor: AuthUser, currentPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!user || !user.isActive) throw new UnauthorizedException();
    await this.assertPassword(user, currentPassword);
    const updated = await this.prisma.user.update({ where: { id: actor.id }, data: { sessionsValidFrom: sessionCutoff() } });
    await audit(this.prisma, {
      entityType: 'USER',
      entityId: actor.id,
      summary: `${updated.fullName} (${updated.username}): бүх төхөөрөмжөөс гарав`,
      actorId: actor.id,
    });
    return this.issue(updated);
  }

  /**
   * Links the Google account the person just picked, so they can sign in with it. The password is asked: a session
   * left open on a shop computer must not become a lasting way in for someone else's Google account.
   */
  async linkGoogle(actor: AuthUser, credential: string, currentPassword: string) {
    const me = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!me || !me.isActive) throw new UnauthorizedException();
    if (me.username === WEBSHOP_USERNAME) throw new BadRequestException(NOT_LINKED);
    await this.assertPassword(me, currentPassword);
    const g = await this.verifyGoogle(credential);
    const taken = () => new ConflictException('Энэ Google бүртгэл өөр хэрэглэгчид холбогдсон / This Google account is linked to another user');
    const owner = await this.prisma.user.findUnique({ where: { googleSub: g.sub }, select: { id: true } });
    if (owner && owner.id !== actor.id) throw taken();
    // An address the admin reserved for someone else as their «Google Gmail» is not taken over.
    if (g.email) {
      const reserved = await this.prisma.user.findFirst({ where: { id: { not: actor.id }, googleEmail: { equals: g.email, mode: 'insensitive' } }, select: { id: true } });
      if (reserved) throw taken();
    }
    let user;
    try {
      user = await this.prisma.user.update({ where: { id: actor.id }, data: { googleSub: g.sub, googleEmail: g.email } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw taken();
      throw err;
    }
    await audit(this.prisma, {
      entityType: 'USER',
      entityId: user.id,
      summary: `${user.fullName} (${user.username}): Google бүртгэл ${g.email ?? ''} холбов`,
      actorId: user.id,
    });
    return this.profile(actor);
  }

  /**
   * Takes the Google account off (password asked). Sessions it may have opened end; this device gets a new token.
   * The admin's «Google Gmail» goes too, so the same address does not link itself again.
   */
  async unlinkGoogle(actor: AuthUser, currentPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!user || !user.isActive) throw new UnauthorizedException();
    await this.assertPassword(user, currentPassword);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { googleSub: null, googleEmail: null, sessionsValidFrom: sessionCutoff() },
    });
    if (user.googleSub || user.googleEmail) {
      await audit(this.prisma, {
        entityType: 'USER',
        entityId: user.id,
        summary: `${user.fullName} (${user.username}): Google бүртгэл ${user.googleEmail ?? ''} салгав (бусад төхөөрөмжөөс гаргав)`,
        actorId: user.id,
      });
    }
    return { ...(await this.issue(updated)), profile: await this.profile(actor) };
  }
}
