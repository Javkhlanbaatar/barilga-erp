/* eslint-disable @typescript-eslint/no-explicit-any */
// «Миний бүртгэл»: own password and details, signing out everywhere, and signing in with Google — only people the
// admin registered: the «Google Gmail» the admin wrote on them (Google must vouch for it), or a Google account
// they linked themselves with their password.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService, GoogleIdentity, googleOwnsEmail } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { FakeDb } from './helpers/fake-db';

/** AuthService with Google's check replaced: the "credential" names one of these identities. */
class TestAuth extends AuthService {
  identities: Record<string, GoogleIdentity> = {};
  protected override async verifyGoogle(credential: string): Promise<GoogleIdentity> {
    const g = this.identities[credential];
    if (!g) throw new BadRequestException('Google sign-in could not be verified');
    return g;
  }
}

// The own-password lock lives for the whole process: each world gets its own user ids.
let worlds = 0;

async function world(clientId: string | null = 'client-123.apps.googleusercontent.com') {
  const n = ++worlds;
  const db = new FakeDb();
  const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } });
  const auth = new TestAuth(db as any, jwt, { get: () => clientId } as any);
  const bat = await db.user.create({
    data: { id: `u-bat-${n}`, username: 'bat', email: 'bat@gmail.com', fullName: 'Бат', role: 'BORLUULAGCH', passwordHash: await bcrypt.hash('Huuchin123', 4) },
  });
  const dorj = await db.user.create({
    data: { id: `u-dorj-${n}`, username: 'dorj', email: 'dorj@example.mn', fullName: 'Дорж', role: 'ACHIGCH_BELTGEGCH', passwordHash: await bcrypt.hash('Dorj12345', 4) },
  });
  const me = (u: any): any => ({ id: u.id, role: u.role, username: u.username, fullName: u.fullName });
  const row = (id: string) => db.user.rows.find((u: any) => u.id === id);
  return { db, jwt, auth, bat, dorj, me, row };
}

const gmail = (sub: string, email: string, extra: Partial<GoogleIdentity> = {}): GoogleIdentity => ({ sub, email, emailVerified: true, name: null, ...extra });

describe('own password and details', () => {
  it('the current password is needed; the new one differs; other devices are signed out; Google is taken off', async () => {
    const w = await world();
    w.row(w.bat.id).googleSub = 'g-old';
    w.row(w.bat.id).googleEmail = 'bat@gmail.com';
    await assert.rejects(() => w.auth.changePassword(w.me(w.bat), 'буруу', 'Shine12345'), BadRequestException);
    await assert.rejects(() => w.auth.changePassword(w.me(w.bat), 'Huuchin123', 'Huuchin123'), /өөр байна/);
    await assert.rejects(() => w.auth.changePassword(w.me(w.bat), 'Huuchin123', 'BAT'), BadRequestException);
    await assert.rejects(() => w.auth.changePassword(w.me(w.bat), 'Huuchin123', 'ш'.repeat(40)), /хэт урт/, 'bcrypt reads 72 bytes');
    const res: any = await w.auth.changePassword(w.me(w.bat), 'Huuchin123', 'Shine12345');
    const row = w.row(w.bat.id);
    assert.ok(await bcrypt.compare('Shine12345', row.passwordHash));
    assert.ok(row.sessionsValidFrom instanceof Date, 'older tokens stop working');
    assert.equal(row.googleSub, null, 'the Google link goes with the old password');
    assert.equal(res.googleUnlinked, true);
    const payload: any = w.jwt.verify(res.accessToken);
    assert.ok(payload.iat * 1000 >= row.sessionsValidFrom.getTime(), 'the new token for this device still works');
    assert.ok(!JSON.stringify(w.db.editAudit.rows).includes('Shine12345'), 'no password in the history');
    await assert.rejects(() => w.auth.login({ username: 'bat', password: 'Huuchin123' }), UnauthorizedException);
    assert.ok((await w.auth.login({ username: 'bat', password: 'Shine12345' })).accessToken);
  });

  it('five wrong current passwords lock the change; sign-in attempts cannot set that lock for someone else', async () => {
    const w = await world();
    for (let i = 0; i < 6; i++) await assert.rejects(() => w.auth.login({ username: w.bat.id, password: 'xxxxxx' }));
    for (let i = 0; i < 6; i++) await assert.rejects(() => w.auth.login({ username: `own:${w.bat.id}`, password: 'xxxxxx' }));
    assert.ok((await w.auth.changePassword(w.me(w.bat), 'Huuchin123', 'Shine12345')).accessToken, 'not locked by sign-in tries');
    for (let i = 0; i < 5; i++) await assert.rejects(() => w.auth.changePassword(w.me(w.dorj), 'буруу', 'Shine12345'), BadRequestException);
    await assert.rejects(() => w.auth.changePassword(w.me(w.dorj), 'Dorj12345', 'Shine12345'), (e: any) => e instanceof BadRequestException && /15 минут/.test(e.message));
  });

  it('name and phone change freely; the e-mail needs the password', async () => {
    const w = await world();
    const p: any = await w.auth.updateProfile(w.me(w.bat), { fullName: 'Бат-Эрдэнэ', phone: '99112233' });
    assert.equal(p.fullName, 'Бат-Эрдэнэ');
    await assert.rejects(() => w.auth.updateProfile(w.me(w.bat), { email: 'shine@gmail.com' }), BadRequestException);
    const q: any = await w.auth.updateProfile(w.me(w.bat), { email: 'shine@gmail.com', currentPassword: 'Huuchin123' });
    assert.equal(q.email, 'shine@gmail.com');
  });

  it('«бүх төхөөрөмжөөс гарах» asks the password, cuts older sessions and keeps this one', async () => {
    const w = await world();
    await assert.rejects(() => w.auth.logoutAll(w.me(w.dorj), 'буруу'), BadRequestException);
    const res: any = await w.auth.logoutAll(w.me(w.dorj), 'Dorj12345');
    const row = w.row(w.dorj.id);
    assert.ok(row.sessionsValidFrom);
    assert.ok((w.jwt.verify(res.accessToken) as any).iat * 1000 >= row.sessionsValidFrom.getTime());
  });
});

describe('sign in with Google', () => {
  it('is off without a client id', async () => {
    const w = await world(null);
    assert.deepEqual(w.auth.publicConfig(), { googleClientId: null });
    const real = new AuthService(w.db as any, w.jwt, { get: () => undefined } as any);
    await assert.rejects(() => real.googleLogin('x'.repeat(30)), /тохируулагдаагүй/);
  });

  it('Google vouches for Gmail, and for a Workspace address only with its hd', () => {
    assert.equal(googleOwnsEmail(gmail('1', 'a@gmail.com')), true);
    assert.equal(googleOwnsEmail(gmail('1', 'a@gmail.com', { emailVerified: false })), false);
    assert.equal(googleOwnsEmail(gmail('1', 'a@company.mn')), false);
    assert.equal(googleOwnsEmail(gmail('1', 'a@company.mn', { hd: 'company.mn' })), true);
    assert.equal(googleOwnsEmail(gmail('1', 'a@company.mn', { hd: 'other.mn' })), false);
  });

  it('the ordinary e-mail never signs in; the admin’s «Google Gmail» does once, then the linked account', async () => {
    const w = await world();
    w.auth.identities.bat = gmail('g-1', 'bat@gmail.com');
    await assert.rejects(() => w.auth.googleLogin('bat'), /боломжгүй/, 'matching the ordinary e-mail is not enough');
    w.row(w.bat.id).googleEmail = 'bat@gmail.com';
    const res: any = await w.auth.googleLogin('bat');
    assert.equal(res.user.username, 'bat');
    assert.equal(w.row(w.bat.id).googleSub, 'g-1');
    w.row(w.bat.id).googleEmail = 'changed@gmail.com';
    assert.equal(((await w.auth.googleLogin('bat')) as any).user.username, 'bat', 'next time by the linked account');
  });

  it('nobody unknown, unvouched, inactive, ambiguous or the web shop gets in; nobody is created', async () => {
    const w = await world();
    w.auth.identities.stranger = gmail('g-9', 'stranger@gmail.com');
    await assert.rejects(() => w.auth.googleLogin('stranger'), UnauthorizedException);
    w.row(w.dorj.id).googleEmail = 'dorj@example.mn';
    w.auth.identities.company = gmail('g-2', 'dorj@example.mn');
    await assert.rejects(() => w.auth.googleLogin('company'), UnauthorizedException, 'a non-Gmail address without hd');
    w.row(w.dorj.id).googleEmail = 'dorj.k@gmail.com';
    w.row(w.dorj.id).isActive = false;
    w.auth.identities.dorj = gmail('g-3', 'dorj.k@gmail.com');
    await assert.rejects(() => w.auth.googleLogin('dorj'), UnauthorizedException);
    assert.equal(w.row(w.dorj.id).googleSub ?? null, null, 'an inactive person is not linked either');
    const shop = await w.db.user.create({ data: { username: 'webshop', fullName: 'Онлайн', role: 'BORLUULAGCH', passwordHash: 'x', googleEmail: 'shop@gmail.com' } });
    w.auth.identities.shop = gmail('g-4', 'shop@gmail.com');
    await assert.rejects(() => w.auth.googleLogin('shop'), UnauthorizedException);
    assert.equal(w.db.user.rows.find((u: any) => u.id === shop.id).googleSub ?? null, null);
    assert.equal(w.db.user.rows.length, 3, 'nobody is created');
  });

  it('linked from «Миний бүртгэл» with the password; once per Google account; unlinking ends other sessions', async () => {
    const w = await world();
    w.auth.identities.personal = gmail('g-5', 'dorj.personal@gmail.com');
    await assert.rejects(() => w.auth.linkGoogle(w.me(w.dorj), 'personal', 'буруу'), BadRequestException);
    const p: any = await w.auth.linkGoogle(w.me(w.dorj), 'personal', 'Dorj12345');
    assert.equal(p.googleLinked, true);
    assert.equal(((await w.auth.googleLogin('personal')) as any).user.username, 'dorj');
    await assert.rejects(() => w.auth.linkGoogle(w.me(w.bat), 'personal', 'Huuchin123'), ConflictException);
    await assert.rejects(() => w.auth.unlinkGoogle(w.me(w.dorj), 'буруу'), BadRequestException);
    const q: any = await w.auth.unlinkGoogle(w.me(w.dorj), 'Dorj12345');
    assert.equal(q.profile.googleLinked, false);
    assert.ok(q.accessToken && w.row(w.dorj.id).sessionsValidFrom, 'other sessions end, this one is renewed');
    await assert.rejects(() => w.auth.googleLogin('personal'), UnauthorizedException);
  });
});

describe('admin side of sign-in', () => {
  const users = (db: FakeDb) => new UsersService(db as any);

  it('the admin changes his own password on «Миний бүртгэл», not here', async () => {
    const w = await world();
    const admin = await w.db.user.create({ data: { id: 'u-admin', username: 'admin', fullName: 'Админ', role: 'ADMIN', passwordHash: 'x' } });
    await assert.rejects(() => users(w.db).update(admin.id, { password: 'Shine12345' } as any, admin.id), /Миний бүртгэл/);
  });

});

describe('second security round', () => {
  it('linking refuses an address the admin reserved for someone else', async () => {
    const w = await world();
    w.row(w.bat.id).googleEmail = 'x@gmail.com';
    w.auth.identities.x = gmail('g-x', 'x@gmail.com');
    await assert.rejects(() => w.auth.linkGoogle(w.me(w.dorj), 'x', 'Dorj12345'), ConflictException);
    assert.equal(((await w.auth.googleLogin('x')) as any).user.username, 'bat', 'the reserved person signs in with it');
  });

  it('the admin does not change his own Google sign-in from «Хэрэглэгчид»', async () => {
    const w = await world();
    const admin = await w.db.user.create({ data: { id: 'u-admin-g', username: 'admin', fullName: 'Админ', role: 'ADMIN', passwordHash: 'x' } });
    const svc = new UsersService(w.db as any);
    await assert.rejects(() => svc.update(admin.id, { googleEmail: 'boss@gmail.com' } as any, admin.id), /Миний бүртгэл/);
    await assert.rejects(() => svc.update(admin.id, { unlinkGoogle: true } as any, admin.id), /Миний бүртгэл/);
  });

  it('a changed address on the linked Google account shows up', async () => {
    const w = await world();
    w.auth.identities.p = gmail('g-p', 'dorj.personal@gmail.com');
    await w.auth.linkGoogle(w.me(w.dorj), 'p', 'Dorj12345');
    w.auth.identities.p = gmail('g-p', 'dorj.new@gmail.com');
    await w.auth.googleLogin('p');
    assert.equal(w.row(w.dorj.id).googleEmail, 'dorj.new@gmail.com');
  });
});
