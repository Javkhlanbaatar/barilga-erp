import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CustomerType, OrderStatus, PaymentStatus, PayMethod, Prisma } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { isManagerRole } from '../inventory/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto, UpdateCustomerDto } from './dto/customer.dto';
import { searchKey } from '../common/translit';

/** Company РД, the same rule the order/E-Barimt flow already uses. */
const COMPANY_REG = /^[0-9A-Z]{7,12}$/;
/** Citizen register number: two Cyrillic letters + 8 digits, e.g. УБ12345678. */
const CITIZEN_REG = /^[А-ЯЁӨҮ]{2}[0-9]{8}$/;

@Injectable()
export class CustomersService {
  private readonly log = new Logger(CustomersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Validates the register number for the customer type; companies must have one. */
  private checkRegNumber(type: CustomerType, reg: string | null | undefined): string | null {
    const value = reg?.trim().toUpperCase() || null;
    if (type === CustomerType.COMPANY) {
      if (!value || !COMPANY_REG.test(value)) {
        throw new BadRequestException('Байгууллагын зөв РД оруулна уу (7–12 тэмдэгт) / A company needs a valid registration number (РД, 7–12 characters)');
      }
    } else if (value && !CITIZEN_REG.test(value)) {
      throw new BadRequestException('Иргэний РД УБ12345678 хэлбэртэй байх ёстой / Citizen register number must look like УБ12345678');
    }
    return value;
  }

  /** Lower-cased text plus its Cyrillic/Latin search key after " | ", so either alphabet finds the customer. */
  static searchText(c: { name: string; phone: string; regNumber: string | null }) {
    const plain = [c.name, c.phone, c.regNumber ?? ''].join(' ').toLowerCase();
    return `${plain} | ${searchKey(c.name)}`;
  }

  /** Customers saved before the search key existed get it once, at start-up. */
  async onModuleInit() {
    try {
      const old = await this.prisma.customer.findMany({
        where: { NOT: { searchText: { contains: ' | ' } } },
        select: { id: true, name: true, phone: true, regNumber: true },
      });
      for (const c of old) {
        await this.prisma.customer.update({ where: { id: c.id }, data: { searchText: CustomersService.searchText(c) } });
      }
    } catch {
      // the table may not exist yet (migrations pending); the next start fills it in
    }
  }

  private rethrowDuplicate(err: unknown): never {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = String(err.meta?.target ?? '');
      throw new ConflictException(
        target.includes('email')
          ? 'A customer with this email already exists'
          : 'A customer with this registration number already exists',
      );
    }
    throw err;
  }

  /**
   * Partner kinds decide money matters (who may take goods on account, who is a supplier or barter partner),
   * so only managers/admin may change them. Returns the fields to write.
   */
  private partnerKinds(
    dto: { buysFromUs?: boolean; creditAllowed?: boolean; sellsToUs?: boolean; barterContract?: string | null },
    user: AuthUser,
    current?: { buysFromUs: boolean; creditAllowed: boolean; sellsToUs: boolean; barterContract: string | null },
  ) {
    const next = {
      ...(dto.buysFromUs !== undefined ? { buysFromUs: dto.buysFromUs } : {}),
      ...(dto.creditAllowed !== undefined ? { creditAllowed: dto.creditAllowed } : {}),
      ...(dto.sellsToUs !== undefined ? { sellsToUs: dto.sellsToUs } : {}),
      ...(dto.barterContract !== undefined ? { barterContract: dto.barterContract?.trim() || null } : {}),
    };
    const changes = Object.entries(next).some(([k, v]) => !current || current[k as keyof typeof current] !== v);
    const defaultsOnly =
      !current && (next.creditAllowed ?? false) === false && (next.sellsToUs ?? false) === false && !next.barterContract && (next.buysFromUs ?? true);
    if (changes && !defaultsOnly && !isManagerRole(user.role)) {
      throw new ForbiddenException('Only a manager or admin can change what a partner is (credit, supplier, barter)');
    }
    return next;
  }

  /**
   * Only managers/admin decide who buys at cost or barter prices. Returns the id to store (null = retail),
   * or undefined when the request does not touch the price list.
   */
  private async checkPriceList(priceListId: string | null | undefined, user: AuthUser, current: string | null = null) {
    if (priceListId === undefined || (priceListId || null) === current) return undefined;
    if (!isManagerRole(user.role)) {
      throw new ForbiddenException('Only a manager or admin can set a customer price list');
    }
    if (!priceListId) return null;
    const list = await this.prisma.priceList.findUnique({ where: { id: priceListId } });
    if (!list || !list.isActive) throw new BadRequestException('Price list not found or inactive');
    return list.id;
  }

  search(q?: string, includeInactive = false) {
    const term = q?.trim().toLowerCase();
    return this.prisma.customer.findMany({
      where: {
        ...(includeInactive ? {} : { isActive: true }),
        ...(term
          ? { OR: [{ searchText: { contains: term } }, ...(searchKey(term) ? [{ searchText: { contains: searchKey(term) } }] : [])] }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: 50,
    });
  }

  /** One customer with their purchase summary and latest orders. */
  async get(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: { priceList: { select: { id: true, name: true } } },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    const [completed, recentOrders, owed] = await Promise.all([
      this.prisma.order.findMany({
        where: { customerId: id, status: OrderStatus.COMPLETED },
        select: { totalMnt: true },
      }),
      this.prisma.order.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, orderNumber: true, status: true, totalMnt: true, createdAt: true },
      }),
      // Goods released on account and not yet paid for.
      this.prisma.payment.findMany({
        where: {
          method: PayMethod.CREDIT,
          status: PaymentStatus.UNPAID,
          amountMnt: { gt: 0 },
          // Same rule as the partner account: only released goods are owed.
          order: { customerId: id, status: { in: [OrderStatus.READY_FOR_LOADING, OrderStatus.COMPLETED] } },
        },
        include: { order: { select: { id: true, orderNumber: true, totalMnt: true, createdAt: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      ...customer,
      stats: {
        completedOrders: completed.length,
        completedTotalMnt: completed.reduce((s, o) => s + o.totalMnt, 0),
      },
      recentOrders,
      credit: {
        owedMnt: owed.reduce((s, p) => s + p.amountMnt, 0),
        orders: owed.map((p) => ({
          orderId: p.order.id,
          orderNumber: p.order.orderNumber,
          totalMnt: p.order.totalMnt,
          owedMnt: p.amountMnt,
          createdAt: p.order.createdAt,
        })),
      },
    };
  }

  async create(dto: CreateCustomerDto, user: AuthUser) {
    const regNumber = this.checkRegNumber(dto.type, dto.regNumber);
    const priceListId = await this.checkPriceList(dto.priceListId, user);
    const kinds = this.partnerKinds(dto, user);
    try {
      const created = await this.prisma.customer.create({
        data: {
          type: dto.type,
          name: dto.name,
          phone: dto.phone,
          regNumber,
          email: dto.email || null,
          address: dto.address || null,
          notes: dto.notes || null,
          priceListId: priceListId ?? null,
          ...kinds,
          searchText: CustomersService.searchText({ name: dto.name, phone: dto.phone, regNumber }),
          createdById: user.id,
        },
      });
      this.log.log(`Customer ${created.id} (${created.type}) created by ${user.id}`);
      return created;
    } catch (err) {
      this.rethrowDuplicate(err);
    }
  }

  async update(id: string, dto: UpdateCustomerDto, user: AuthUser) {
    const existing = await this.prisma.customer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Customer not found');
    if (dto.isActive !== undefined && dto.isActive !== existing.isActive && !isManagerRole(user.role)) {
      throw new ForbiddenException('Only a manager or admin can activate or deactivate a customer');
    }
    const regNumber =
      dto.regNumber !== undefined ? this.checkRegNumber(existing.type, dto.regNumber) : existing.regNumber;
    const priceListId = await this.checkPriceList(dto.priceListId, user, existing.priceListId);
    const kinds = this.partnerKinds(dto, user, existing);
    try {
      return await this.prisma.customer.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.regNumber !== undefined ? { regNumber } : {}),
          ...(dto.email !== undefined ? { email: dto.email || null } : {}),
          ...(dto.address !== undefined ? { address: dto.address || null } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(priceListId !== undefined ? { priceListId } : {}),
          ...kinds,
          searchText: CustomersService.searchText({
            name: dto.name ?? existing.name,
            phone: dto.phone ?? existing.phone,
            regNumber,
          }),
        },
      });
    } catch (err) {
      this.rethrowDuplicate(err);
    }
  }

  /** For order creation: the customer must exist and be active. */
  async requireActive(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new BadRequestException('Customer not found');
    if (!customer.isActive) throw new BadRequestException('Customer is deactivated');
    return customer;
  }
}
