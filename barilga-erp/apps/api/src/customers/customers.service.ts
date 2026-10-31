import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CustomerType, OrderStatus, Prisma } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { seesAllWarehouses } from '../inventory/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto, UpdateCustomerDto } from './dto/customer.dto';

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
        throw new BadRequestException('A company needs a valid registration number (РД, 7–12 characters)');
      }
    } else if (value && !CITIZEN_REG.test(value)) {
      throw new BadRequestException('Citizen register number must look like УБ12345678');
    }
    return value;
  }

  private static searchText(c: { name: string; phone: string; regNumber: string | null }) {
    return [c.name, c.phone, c.regNumber ?? ''].join(' ').toLowerCase();
  }

  private rethrowDuplicate(err: unknown): never {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictException('A customer with this registration number already exists');
    }
    throw err;
  }

  search(q?: string, includeInactive = false) {
    const term = q?.trim().toLowerCase();
    return this.prisma.customer.findMany({
      where: {
        ...(includeInactive ? {} : { isActive: true }),
        ...(term ? { searchText: { contains: term } } : {}),
      },
      orderBy: { name: 'asc' },
      take: 50,
    });
  }

  /** One customer with their purchase summary and latest orders. */
  async get(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('Customer not found');
    const [completed, recentOrders] = await Promise.all([
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
    ]);
    return {
      ...customer,
      stats: {
        completedOrders: completed.length,
        completedTotalMnt: completed.reduce((s, o) => s + o.totalMnt, 0),
      },
      recentOrders,
    };
  }

  async create(dto: CreateCustomerDto, user: AuthUser) {
    const regNumber = this.checkRegNumber(dto.type, dto.regNumber);
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
    if (dto.isActive !== undefined && dto.isActive !== existing.isActive && !seesAllWarehouses(user.role)) {
      throw new ForbiddenException('Only a manager or admin can activate or deactivate a customer');
    }
    const regNumber =
      dto.regNumber !== undefined ? this.checkRegNumber(existing.type, dto.regNumber) : existing.regNumber;
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
