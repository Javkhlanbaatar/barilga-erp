import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AccountEntryKind, BillType, OrderStatus, PaymentStatus, Prisma, Role, SourceType, TransferStatus } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { searchKey } from '../common/translit';
import { partnerPayable } from '../customers/partner-payable';
import { isFallbackPicker, isHiredTransport, isPosActor, isTransportActor, isWarehouseActor } from '../auth/rbac';
import { EbarimtService } from '../ebarimt/ebarimt.service';
import { FeaturesService } from '../features/features.service';
import { InventoryService } from '../inventory/inventory.service';
import { assertWarehouseAccess, lockedWarehouseId } from '../inventory/warehouse-scope';
import { LogisticsService } from '../logistics/logistics.service';
import { isZeroFeeMethod } from '../logistics/logistics.engine';
import { PaymentService } from '../payment/payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { planFulfillment } from './fulfillment-plan';
import { createWithUniqueOrderNumber } from './order-number';
import {
  AssignDriverDto,
  AssignSupplierDto,
  CheckoutPaymentMethod,
  CompleteFulfillmentDto,
  CreateOrderDto,
  OverrideFeesDto,
  QuoteOrderDto,
} from './dto/order.dto';

const DRIVER_PHONE_RE = /^[0-9+\-]{8,15}$/;
/** Order money columns are 32-bit integers; stay well inside them. */
const MAX_ORDER_SUBTOTAL_MNT = 2_000_000_000;

const ORDER_INCLUDE = {
  items: { include: { product: true, pickedBy: { select: { id: true, fullName: true } } } },
  zone: true,
  warehouse: { select: { id: true, code: true, name: true } },
  payments: { orderBy: { createdAt: 'asc' as const } },
  createdBy: { select: { id: true, fullName: true, role: true } },
  completedBy: { select: { id: true, fullName: true, role: true } },
  preparedBy: { select: { id: true, fullName: true, role: true } },
  pickingStartedBy: { select: { id: true, fullName: true } },
  feeOverrides: { orderBy: { createdAt: 'desc' as const }, include: { actor: { select: { fullName: true, role: true } } } },
  returns: {
    orderBy: { createdAt: 'desc' as const },
    include: {
      items: { include: { orderItem: { include: { product: true } } } },
      createdBy: { select: { id: true, fullName: true, role: true } },
    },
  },
  supplierPayables: true,
  stockReconciliations: {
    orderBy: { createdAt: 'desc' as const },
    include: { actor: { select: { id: true, fullName: true, role: true } } },
  },
};

@Injectable()
export class OrdersService {
  private readonly log = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly logistics: LogisticsService,
    private readonly payments: PaymentService,
    private readonly inventory: InventoryService,
    private readonly ebarimt: EbarimtService,
    private readonly features?: FeaturesService,
  ) {}

  async buildSpecs(
    items: { productId: string; quantity: number; sourceType?: SourceType; supplierName?: string }[],
    /** Customer price list prices by product; products missing from it sell at retail. */
    listPrices?: Map<string, number>,
  ) {
    const ids = items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({ where: { id: { in: ids }, active: true } });
    if (products.length !== ids.length) {
      throw new BadRequestException('One or more products are invalid or inactive');
    }
    const byId = new Map(products.map((p) => [p.id, p]));
    let subtotalMnt = 0;
    let weightKg = 0;
    let maxLengthM = 0;
    let volumeM3 = 0;
    const lines = items.map((line) => {
      const product = byId.get(line.productId)!;
      const qty = line.quantity;
      const unitPrice = listPrices?.get(product.id) ?? product.priceMnt;
      const lineTotal = Math.round(unitPrice * qty);
      const w = Number(product.weightKg) * qty;
      const v = Number(product.volumeM3) * qty;
      const len = Number(product.lengthM);
      subtotalMnt += lineTotal;
      if (subtotalMnt > MAX_ORDER_SUBTOTAL_MNT) {
        throw new BadRequestException('Order value is too large');
      }
      weightKg += w;
      volumeM3 += v;
      maxLengthM = Math.max(maxLengthM, len);
      const sourceType =
        line.sourceType ?? product.sourceType ?? SourceType.INTERNAL;
      if (sourceType === SourceType.EXTERNAL_SUPPLIER && !line.supplierName?.trim() && !product.sku) {
        throw new BadRequestException('supplierName is required for external supplier items');
      }
      return {
        productId: product.id,
        quantity: new Prisma.Decimal(qty),
        unitPrice,
        weightKg: new Prisma.Decimal(w),
        lengthM: new Prisma.Decimal(len),
        volumeM3: new Prisma.Decimal(v),
        lineTotal,
        sourceType,
        supplierName:
          sourceType === SourceType.EXTERNAL_SUPPLIER
            ? line.supplierName?.trim() || 'Other store'
            : null,
      };
    });
    return {
      lines,
      specs: {
        subtotalMnt,
        weightKg: Number(weightKg.toFixed(3)),
        maxLengthM: Number(maxLengthM.toFixed(2)),
        volumeM3: Number(volumeM3.toFixed(3)),
      },
    };
  }

  /**
   * Which warehouse an order takes its stock from: the one asked for, else the user's own, else the default.
   * Staff locked to a warehouse can only sell from it.
   */
  private async resolveOrderWarehouse(requested: string | undefined, user: AuthUser) {
    const locked = lockedWarehouseId(user);
    if (locked && requested && requested !== locked) {
      throw new ForbiddenException('You can only create orders for your own warehouse');
    }
    return this.inventory.resolveWarehouseId(this.prisma, requested ?? user.warehouseId ?? null);
  }

  async resolveZoneId(zoneId: string | undefined, method: QuoteOrderDto['deliveryMethod']) {
    if (zoneId) return zoneId;
    if (method !== 'SELF_PICKUP' && method !== 'CUSTOMER_DRIVER') {
      throw new BadRequestException('zoneId is required for DELIVERY');
    }
    const fallback = await this.prisma.zone.findFirst({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
    });
    if (!fallback) throw new BadRequestException('No delivery zone configured');
    return fallback.id;
  }

  async quote(dto: QuoteOrderDto) {
    const customer = await this.resolveCustomer(dto.customerId);
    const { lines, specs } = await this.buildSpecs(dto.items, customer?.prices);
    const zoneId = await this.resolveZoneId(dto.zoneId, dto.deliveryMethod);
    const quote = await this.logistics.quote({
      zoneId,
      method: dto.deliveryMethod,
      time: dto.timeCondition ?? 'STANDARD',
      unloadingRequested: isZeroFeeMethod(dto.deliveryMethod) ? false : dto.unloadingRequested,
      specs,
    });
    // The price each line will be sold at (the customer's list or retail), so the till shows the real amounts.
    return {
      ...quote,
      priceList: customer?.priceListName ?? null,
      lines: lines.map((l) => ({ productId: l.productId, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    };
  }

  /**
   * Staff locked to a warehouse may only act on that warehouse's orders. Must run BEFORE any write.
   * Orders from before warehouses existed (warehouseId null) belong to the default warehouse.
   */
  private async assertOrderAccess(user: AuthUser, warehouseId: string | null) {
    if (!lockedWarehouseId(user)) return;
    const fallback = warehouseId ? undefined : await this.inventory.defaultWarehouseId();
    assertWarehouseAccess(user, warehouseId, fallback);
  }

  /** List filter for a locked user's own warehouse (including pre-warehouse orders when it is the default). */
  private async orderScope(user: AuthUser): Promise<Prisma.OrderWhereInput> {
    const locked = lockedWarehouseId(user);
    if (!locked) return {};
    const isDefault = locked === (await this.inventory.defaultWarehouseId());
    return isDefault ? { OR: [{ warehouseId: locked }, { warehouseId: null }] } : { warehouseId: locked };
  }

  /** A linked customer must exist and be active, and the customer module must be switched on. */
  private async resolveCustomerId(customerId?: string): Promise<string | null> {
    return (await this.resolveCustomer(customerId))?.id ?? null;
  }

  /**
   * The linked customer and, when the price-list module is on and their list is active, the prices they buy at.
   */
  private async resolveCustomer(customerId?: string) {
    if (!customerId) return null;
    if (!this.features) throw new BadRequestException('Customer linking is not available');
    await this.features.assertEnabled('CUSTOMERS');
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { priceList: { include: { items: true } } },
    });
    if (!customer) throw new BadRequestException('Customer not found');
    if (!customer.isActive) throw new BadRequestException('Customer is deactivated');
    const list = customer.priceList?.isActive && (await this.features.isEnabled('PRICE_LISTS')) ? customer.priceList : null;
    return {
      id: customer.id,
      creditAllowed: customer.creditAllowed,
      contractPartner: customer.sellsToUs || !!customer.barterContract,
      name: customer.name,
      priceListId: list?.id ?? null,
      priceListName: list?.name ?? null,
      prices: list ? new Map(list.items.map((i) => [i.productId, i.priceMnt])) : undefined,
    };
  }

  async create(dto: CreateOrderDto, user: AuthUser) {
    if (!isPosActor(user.role)) {
      throw new ForbiddenException('Only cashiers, managers, or admin can create orders');
    }
    const customer = await this.resolveCustomer(dto.customerId);
    const splitMethods = dto.payments?.length ? dto.payments.map((p) => p.method) : [dto.paymentMethod ?? CheckoutPaymentMethod.QPAY];
    if (splitMethods.includes(CheckoutPaymentMethod.CREDIT)) {
      // Releasing goods on account needs someone to owe the money: a registered customer.
      if (this.features) await this.features.assertEnabled('CREDIT_SALES');
      if (!customer) throw new BadRequestException('Дараа төлөхөөр олгоход бүртгэлтэй харилцагч сонгоно уу / On-account sale needs a registered customer');
      if (!customer.creditAllowed) {
        throw new ForbiddenException('Энэ харилцагчид дараа төлөх эрх менежерээс олгогдоогүй / Customer may not take goods on account');
      }
    }
    if (splitMethods.includes(CheckoutPaymentMethod.INVOICE) && this.features) await this.features.assertEnabled('INVOICES');
    const contractSplits = (dto.payments ?? []).filter((p) => p.method === CheckoutPaymentMethod.CONTRACT);
    if (splitMethods.includes(CheckoutPaymentMethod.CONTRACT)) {
      if (this.features) await this.features.assertEnabled('PARTNER_ACCOUNTS');
      if (!customer) throw new BadRequestException('Гэрээгээр олгоход харилцагч сонгоно уу / Contract sale needs a partner');
      if (!customer.contractPartner) {
        throw new ForbiddenException('Энэ харилцагч нийлүүлэгч эсвэл бартерын гэрээтэй биш / Customer has no supply or barter contract');
      }
      // The other parts must be paid on the spot, so the goods are released (and netted) right away.
      if (splitMethods.some((m) => m === CheckoutPaymentMethod.QPAY || m === CheckoutPaymentMethod.INVOICE)) {
        throw new BadRequestException('Гэрээгээр олгохдоо үлдсэн хэсгийг бэлэн, карт эсвэл шилжүүлгээр авна / Contract part goes with cash, card or transfer only');
      }
      if (contractSplits.length > 1 || splitMethods.includes(CheckoutPaymentMethod.CREDIT)) {
        throw new BadRequestException('Гэрээгээр болон дараа төлөхөөр нэг захиалгад зэрэг олгохгүй / Only one contract part, not combined with on-account');
      }
      if (!dto.payments?.length) {
        throw new BadRequestException('Гэрээгээр олгоход дүнг хувааж оруулна / Send the contract part as a payment split');
      }
      // Checked before anything is written: the contract part may not exceed what we currently owe the partner.
      const payable = await this.partnerPayable(customer.id);
      if (contractSplits[0].amount > payable) {
        throw new BadRequestException(`Гэрээгээр олгох дүн бидний өглөгөөс (${payable}₮) их байна / Contract part exceeds what we owe (${payable}₮)`);
      }
    }
    const zoneId = await this.resolveZoneId(dto.zoneId, dto.deliveryMethod);
    const unloadingRequested = isZeroFeeMethod(dto.deliveryMethod) ? false : dto.unloadingRequested;
    const { lines, specs } = await this.buildSpecs(dto.items, customer?.prices);
    const { breakdown } = await this.logistics.quote({
      zoneId,
      method: dto.deliveryMethod,
      time: dto.timeCondition ?? 'STANDARD',
      unloadingRequested,
      specs,
    });

    // Split payments must add up to the total before anything is written, so a typo at the till does not
    // leave a cancelled order behind in the list.
    if (dto.payments?.length) {
      const sum = dto.payments.reduce((s, p) => s + Math.round(Number(p.amount)), 0);
      if (sum !== breakdown.totalMnt) {
        throw new BadRequestException(`Төлбөрийн хуваалт ${sum}₮ нь нийт дүн ${breakdown.totalMnt}₮-тэй тэнцэхгүй / Payment splits do not equal the total`);
      }
    }
    const billType = dto.billType ?? BillType.CITIZEN;
    const customerRegNumber = dto.customerRegNumber?.trim() || null;
    if (billType === BillType.COMPANY) {
      if (!customerRegNumber || !/^[0-9A-Za-z]{7,12}$/.test(customerRegNumber)) {
        throw new BadRequestException('Company E-Barimt requires a valid registration number (РД, 7–12 characters)');
      }
    }

    const customerId = customer?.id ?? null;
    const hiredOnCreate = this.optionalHiredOnCreate(dto);
    const warehouseId = await this.resolveOrderWarehouse(dto.warehouseId, user);
    const trackingToken = randomBytes(24).toString('base64url');
    const order = await createWithUniqueOrderNumber(this.prisma, (orderNumber) =>
      this.prisma.order.create({
      data: {
        orderNumber,
        status: OrderStatus.PENDING_PAYMENT,
        customerName: dto.customerName?.trim() || 'Энгийн харилцагч',
        customerPhone: dto.customerPhone,
        customerId,
        priceListId: customer?.priceListId ?? null,
        deliveryAddress: dto.deliveryAddress,
        notes: dto.notes,
        billType,
        customerRegNumber: billType === BillType.COMPANY ? customerRegNumber : null,
        warehouseId,
        zoneId,
        deliveryMethod: dto.deliveryMethod,
        timeCondition: dto.timeCondition ?? 'STANDARD',
        unloadingRequested,
        totalWeightKg: specs.weightKg,
        maxLengthM: specs.maxLengthM,
        totalVolumeM3: specs.volumeM3,
        assignedVehicle: breakdown.assignedVehicle,
        subtotalMnt: breakdown.subtotalMnt,
        deliveryFeeMnt: breakdown.deliveryFeeMnt,
        unloadingFeeMnt: breakdown.unloadingFeeMnt,
        timeAdjustmentMnt: breakdown.timeAdjustmentMnt,
        totalMnt: breakdown.totalMnt,
        createdById: user.id,
        trackingToken,
        ...(hiredOnCreate
          ? {
              vehicleNumber: hiredOnCreate.vehicleNumber,
              driverPhone: hiredOnCreate.driverPhone,
              driverName: hiredOnCreate.driverName,
            }
          : {}),
        items: { create: lines },
      },
      include: ORDER_INCLUDE,
      }),
    );

    const splits =
      dto.payments && dto.payments.length > 0
        ? dto.payments.map((p) => ({ method: p.method, amount: p.amount }))
        : [{ method: dto.paymentMethod ?? CheckoutPaymentMethod.QPAY, amount: order.totalMnt }];
    const contract = splits.find((s) => s.method === CheckoutPaymentMethod.CONTRACT);
    // Recorded as an on-account part, then closed at once against our payable below.
    if (contract) contract.method = CheckoutPaymentMethod.CREDIT;
    try {
      const recorded = await this.payments.settleSplits(order.id, splits, user.id);
      this.log.log(
        `Order ${order.orderNumber} created; ${recorded.length} payment split(s)`,
      );
    } catch (err) {
      // Cancel only if no money was recorded. If a split is already PAID (e.g. the failure came after the
      // payments were written), leave the order as it is so the cash is not hidden behind a CANCELLED order.
      await this.prisma.$transaction(async (tx) => {
        const paid = await tx.payment.count({ where: { orderId: order.id, status: PaymentStatus.PAID } });
        if (paid > 0) {
          this.log.error(`Order ${order.orderNumber}: payment setup failed after money was recorded; left for manual review`);
          return;
        }
        await tx.payment.updateMany({
          where: { orderId: order.id, status: PaymentStatus.UNPAID },
          data: { status: PaymentStatus.EXPIRED, nextPollAt: null },
        });
        await tx.order.updateMany({
          where: { id: order.id, status: OrderStatus.PENDING_PAYMENT },
          data: { status: OrderStatus.CANCELLED, notes: `${dto.notes ?? ''}\nPayment setup failed`.trim() },
        });
      });
      throw err;
    }
    if (contract && customer) await this.closeAgainstPayable(order.id, order.orderNumber, customer.id, Math.round(Number(contract.amount)), user.id);
    const created = await this.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: ORDER_INCLUDE });
    return this.presentOrder(created, user.role);
  }

  /** What we owe the partner: purchases minus our payments and offsets (positive = we owe them). */
  private partnerPayable(customerId: string) {
    return partnerPayable(this.prisma, customerId);
  }

  /**
   * Contract sale: the on-account part is paid at once out of what we owe the partner (one OFFSET payment and one
   * OFFSET account line, the same records as a manual хасалт). If our payable shrank meanwhile, the part is left
   * as an ordinary debt on the partner's account for a manager to settle — it is never silently dropped.
   */
  private async closeAgainstPayable(orderId: string, orderNumber: string, customerId: string, amountMnt: number, actorId: string) {
    try {
      // The payable is re-read inside the same Serializable transaction as the settlement and the OFFSET line,
      // so two contract sales at once cannot both spend the same payable.
      await this.payments.settleCredit(orderId, 'OFFSET', amountMnt, actorId, {
        before: async (tx) => {
          if (amountMnt > (await partnerPayable(tx, customerId))) throw new BadRequestException('payable_shrank');
        },
        after: async (tx) => {
          await tx.accountEntry.create({
            data: {
              customerId,
              kind: AccountEntryKind.OFFSET,
              amountMnt: -amountMnt,
              description: `Гэрээгээр олгосон — ${orderNumber}`,
              refType: 'ORDER',
              refId: orderId,
              createdById: actorId,
            },
          });
        },
      });
    } catch (err) {
      this.log.warn(`Contract sale ${orderNumber}: not netted (${err instanceof Error ? err.message : err}); left on the partner account as debt`);
    }
  }

  /**
   * Fees may change only while NOTHING has been paid. The order total and the QPay invoice amount move
   * together in one transaction: the old invoice is expired and a new one for the new total is issued,
   * so the amount the customer is asked to pay always equals the order total. Orders with any paid split
   * (e.g. cash already taken) are refused; this system has no rule for re-pricing paid money.
   */
  async overrideFees(orderId: string, dto: OverrideFeesDto, user: AuthUser) {
    if (user.role !== Role.BORLUULAGCH) {
      throw new ForbiddenException('Only cashiers (BORLUULAGCH) can override fees');
    }
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { payments: true } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Fees can only be overridden before payment');
    }
    if (order.payments.some((p) => p.status === PaymentStatus.PAID)) {
      throw new BadRequestException('Fees cannot be changed once any payment has been received');
    }
    if (isZeroFeeMethod(order.deliveryMethod) && (dto.deliveryFeeMnt !== 0 || dto.unloadingFeeMnt !== 0)) {
      throw new BadRequestException(
        'SELF_PICKUP and CUSTOMER_DRIVER must keep delivery and unloading fees at 0₮',
      );
    }
    if (
      dto.deliveryFeeMnt === order.deliveryFeeMnt &&
      dto.unloadingFeeMnt === order.unloadingFeeMnt &&
      dto.timeAdjustmentMnt === order.timeAdjustmentMnt
    ) {
      throw new BadRequestException('Fees are unchanged');
    }

    if (this.features) await this.features.assertEnabled('DELIVERY');
    const newTotal = order.subtotalMnt + dto.deliveryFeeMnt + dto.unloadingFeeMnt + dto.timeAdjustmentMnt;
    // Fees can be waived, but never turned into a discount on the goods themselves.
    if (newTotal < order.subtotalMnt || dto.deliveryFeeMnt < 0 || dto.unloadingFeeMnt < 0) {
      throw new BadRequestException('Хураамжийг барааны үнээс доош хасаж болохгүй / Fees cannot discount the goods');
    }

    await this.payments.replaceSoleQpayInvoice(orderId, newTotal, async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING_PAYMENT, totalMnt: order.totalMnt },
        data: {
          deliveryFeeMnt: dto.deliveryFeeMnt,
          unloadingFeeMnt: dto.unloadingFeeMnt,
          timeAdjustmentMnt: dto.timeAdjustmentMnt,
          totalMnt: newTotal,
          feesOverridden: true,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('The order changed while updating fees; nothing was changed');
      }
      await tx.feeOverrideAudit.create({
        data: {
          orderId,
          actorId: user.id,
          reason: dto.reason,
          previousDeliveryFee: order.deliveryFeeMnt,
          previousUnloadingFee: order.unloadingFeeMnt,
          previousTimeAdj: order.timeAdjustmentMnt,
          previousTotal: order.totalMnt,
          newDeliveryFee: dto.deliveryFeeMnt,
          newUnloadingFee: dto.unloadingFeeMnt,
          newTimeAdj: dto.timeAdjustmentMnt,
          newTotal,
        },
      });
    });

    this.log.log(`Fee override on ${order.orderNumber} by ${user.email}: ${dto.reason}`);
    return this.findOne(orderId, user);
  }

  /** Staff cancel of an order that has no recorded payment (see PaymentService.cancelUnpaidOrder). */
  async cancel(orderId: string, user: AuthUser, reason?: string) {
    if (!isPosActor(user.role)) {
      throw new ForbiddenException('Only cashiers, managers, or admin can cancel orders');
    }
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    const who = user.fullName ?? user.name ?? user.email ?? user.id;
    await this.payments.cancelUnpaidOrder(orderId, reason?.trim() ? `${reason.trim()} (by ${who})` : `Cancelled by ${who}`);
    return this.findOne(orderId, user);
  }

  private optionalHiredOnCreate(dto: CreateOrderDto) {
    if (!isHiredTransport(dto.deliveryMethod)) return null;
    const vehicleNumber = dto.vehicleNumber?.trim() ?? '';
    const driverPhone = (dto.driverPhone?.trim() ?? '').replace(/\s+/g, '');
    if (!vehicleNumber && !driverPhone) return null;
    if (vehicleNumber.length < 2 || !DRIVER_PHONE_RE.test(driverPhone)) {
      throw new BadRequestException(
        'Provide both truck plate and driver phone, or leave both empty to enter later via the tracking link',
      );
    }
    return { vehicleNumber, driverPhone, driverName: null };
  }

  async findPublicByToken(token: string) {
    const order = await this.prisma.order.findUnique({
      where: { trackingToken: token },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Order not found');
    return this.presentPublic(order);
  }

  async updateTransportByToken(token: string, dto: AssignDriverDto) {
    const order = await this.prisma.order.findUnique({ where: { trackingToken: token } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.COMPLETED) {
      throw new BadRequestException('Transport can no longer be changed after fulfillment or cancellation');
    }
    if (!isHiredTransport(order.deliveryMethod)) {
      throw new BadRequestException(
        'Hired transport notes apply only to company delivery (not self-pickup or customer driver)',
      );
    }
    const hired = this.hiredTransportNotes(order.deliveryMethod, order, dto);
    if (!hired) {
      throw new BadRequestException(
        'Hired transport notes apply only to company delivery (not self-pickup or customer driver)',
      );
    }
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        vehicleNumber: hired.vehicleNumber,
        driverPhone: hired.driverPhone,
        driverName: hired.driverName,
      },
    });
    this.log.log(`Public tracking ${order.orderNumber} hired ${hired.vehicleNumber} / ${hired.driverPhone}`);
    return this.findPublicByToken(token);
  }

  private presentPublic(order: Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>) {
    return {
      orderNumber: order.orderNumber,
      status: order.status,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      deliveryAddress: order.deliveryAddress,
      deliveryMethod: order.deliveryMethod,
      zone: { nameMn: order.zone.nameMn, code: order.zone.code },
      assignedVehicle: order.assignedVehicle,
      vehicleNumber: order.vehicleNumber,
      driverPhone: order.driverPhone,
      totalMnt: order.totalMnt,
      subtotalMnt: order.subtotalMnt,
      deliveryFeeMnt: order.deliveryFeeMnt,
      unloadingFeeMnt: order.unloadingFeeMnt,
      timeAdjustmentMnt: order.timeAdjustmentMnt,
      items: order.items.map((item) => ({
        nameMn: item.product.nameMn,
        quantity: item.quantity,
        unit: item.product.unit,
        lineTotal: item.lineTotal,
      })),
      payments: order.payments.map((p) => ({
        method: p.method,
        status: p.status,
        amountMnt: p.amountMnt,
        qpayQrImage: p.qpayQrImage,
        qpayQrText: p.qpayQrText,
      })),
      trackingToken: order.trackingToken,
    };
  }

  private hiredTransportNotes(
    method: string,
    existing: { vehicleNumber: string | null; driverPhone: string | null; driverName: string | null },
    dto?: CompleteFulfillmentDto | AssignDriverDto,
  ) {
    if (!isHiredTransport(method)) return null;
    const vehicleNumber = (dto?.vehicleNumber?.trim() || existing.vehicleNumber || '').trim();
    const driverPhone = (dto?.driverPhone?.trim() || existing.driverPhone || '').trim().replace(/\s+/g, '');
    const driverName = (dto?.driverName?.trim() || existing.driverName || '').trim() || null;
    if (vehicleNumber.length < 2 || !DRIVER_PHONE_RE.test(driverPhone)) {
      throw new BadRequestException(
        'Hired delivery requires truck plate (vehicleNumber) and driver phone before fulfillment can be completed',
      );
    }
    return { vehicleNumber, driverPhone, driverName };
  }

  async complete(orderId: string, user: AuthUser, dto: CompleteFulfillmentDto = {}) {
    if (!isWarehouseActor(user.role)) {
      throw new ForbiddenException(
        'Warehouse staff, cashiers, managers, or admin can complete fulfillment',
      );
    }
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    if (order.status !== OrderStatus.READY_FOR_LOADING) {
      throw new BadRequestException(
        `Illegal transition ${order.status} → COMPLETED. Order must be PAID (READY_FOR_LOADING).`,
      );
    }
    // Stock being collected for this order has not reached the dispatch warehouse yet: loading now would
    // ship goods that are not there (and push its balance negative). Receive or cancel those transfers first.
    const gathering = await this.prisma.stockTransfer.count({
      where: { orderId, status: TransferStatus.IN_TRANSIT },
    });
    if (gathering > 0) {
      throw new ConflictException(
        `${gathering} transfer(s) collecting stock for this order are still in transit; receive them first`,
      );
    }
    const hired = this.hiredTransportNotes(order.deliveryMethod, order, dto);
    const completedAt = new Date();
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const updated = await this.prisma.$transaction(
          async (tx) => {
            const claimed = await tx.order.updateMany({
              where: { id: orderId, status: OrderStatus.READY_FOR_LOADING },
              data: {
                status: OrderStatus.COMPLETED,
                completedById: user.id,
                completedAt,
                preparedById: user.id,
                preparedAt: completedAt,
                ...(hired
                  ? {
                      vehicleNumber: hired.vehicleNumber,
                      driverPhone: hired.driverPhone,
                      driverName: hired.driverName,
                    }
                  : {}),
              },
            });
            if (claimed.count !== 1) {
              const current = await tx.order.findUnique({ where: { id: orderId } });
              throw new BadRequestException(
                `Illegal transition ${current?.status ?? 'UNKNOWN'} → COMPLETED. Order must be PAID (READY_FOR_LOADING).`,
              );
            }
            const withItems = await tx.order.findUniqueOrThrow({
              where: { id: orderId },
              include: { items: true },
            });
            // Anything already returned while the order was waiting for loading never left stock,
            // so only the net quantity is deducted (and only the net amount is owed to suppliers).
            const returned = await tx.returnItem.findMany({
              where: { orderItem: { orderId } },
            });
            const plan = planFulfillment(withItems.items, returned);
            await this.inventory.deductForOrder(tx, plan.deductions, {
              warehouseId: withItems.warehouseId,
              refType: 'ORDER',
              refId: orderId,
              reason: `Order ${withItems.orderNumber} completed`,
              actorId: user.id,
            });
            // A manager may already have assigned a supplier before completion (assignSupplier creates
            // the OPEN payable then); never owe the supplier twice for the same line.
            const open = await tx.supplierPayable.findMany({ where: { orderId, status: 'OPEN' } });
            const alreadyOwed = new Set(open.map((p) => p.orderItemId));
            for (const payable of plan.payables) {
              if (alreadyOwed.has(payable.orderItemId)) continue;
              await tx.supplierPayable.create({ data: { orderId, ...payable } });
            }
            return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        this.log.log(
          `Order ${order.orderNumber} COMPLETED at ${completedAt.toISOString()} preparedBy=${user.id} ${user.fullName ?? user.name} (${user.role})${isFallbackPicker(user.role) ? ' fallbackPicker=true' : ''}; stock deducted`,
        );
        return this.presentOrder(updated, user.role);
      } catch (err) {
        lastError = err;
        const code = (err as { code?: string }).code;
        if (code === 'P2034' && attempt < maxAttempts) {
          this.log.warn(`Stock completion retry ${attempt} for ${order.orderNumber} (serialization conflict)`);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /** The customer pays (part of) what they owe on an order released on account. */
  /** The waiting part (unpaid QPay or awaited transfer) was paid another way at the till. */
  async payRemaining(orderId: string, method: 'CASH' | 'CARD' | 'TRANSFER', user: AuthUser) {
    if (!isPosActor(user.role)) throw new ForbiddenException('Only cashiers, managers, or admin can take payments');
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    await this.payments.payRemaining(orderId, method, user.id);
    return this.findOne(orderId, user);
  }

  async confirmTransfer(orderId: string, user: AuthUser) {
    if (!isPosActor(user.role)) throw new ForbiddenException('Only cashiers, managers, or admin can confirm payments');
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    await this.payments.confirmTransfer(orderId, user.id);
    return this.findOne(orderId, user);
  }

  async settleCredit(orderId: string, method: 'CASH' | 'CARD' | 'TRANSFER', amountMnt: number, user: AuthUser) {
    if (!isPosActor(user.role)) {
      throw new ForbiddenException('Only cashiers, managers, or admin can take payments');
    }
    if (this.features) await this.features.assertEnabled('CREDIT_SALES');
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    await this.payments.settleCredit(orderId, method, amountMnt, user.id);
    return this.findOne(orderId, user);
  }

  /** Sets the start of preparation once (the first caller wins; later calls change nothing). */
  private markPickingStarted(orderId: string, userId: string) {
    return this.prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.READY_FOR_LOADING, pickingStartedAt: null },
      data: { pickingStartedAt: new Date(), pickingStartedById: userId },
    });
  }

  /**
   * "Би бэлдье": a worker takes the order; it moves from the queue to "being prepared" and the preparation
   * time starts. Pressing it again (or by a second picker joining) keeps the original start.
   */
  async startPicking(orderId: string, user: AuthUser) {
    if (!isWarehouseActor(user.role)) {
      throw new ForbiddenException('Warehouse staff, cashiers, managers, or admin can prepare orders');
    }
    if (this.features) await this.features.assertEnabled('PICKING');
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    if (order.status !== OrderStatus.READY_FOR_LOADING) {
      throw new BadRequestException('Only a paid order waiting for loading can be prepared');
    }
    const started = await this.markPickingStarted(orderId, user.id);
    if (started.count === 1) this.log.log(`Picking started on ${order.orderNumber} by ${user.id}`);
    return this.findOne(orderId, user);
  }

  /**
   * Picking checklist: a worker ticks one line as prepared (or unticks a mistake). Several people can pick
   * one order at once; each line records who picked it. Only for paid orders waiting to be loaded.
   * Completing an order does not require every line to be ticked (the UI warns instead).
   */
  async pickItem(orderId: string, itemId: string, picked: boolean, user: AuthUser) {
    if (!isWarehouseActor(user.role)) {
      throw new ForbiddenException('Warehouse staff, cashiers, managers, or admin can pick orders');
    }
    if (this.features) await this.features.assertEnabled('PICKING');
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    if (order.status !== OrderStatus.READY_FOR_LOADING) {
      throw new BadRequestException('Only a paid order waiting for loading can be picked');
    }
    // Ticking the first line also starts preparation, so the clock runs even if nobody pressed "start".
    if (picked) await this.markPickingStarted(orderId, user.id);
    // Conditional update: two people ticking the same line at once leave one consistent picker.
    const changed = await this.prisma.orderItem.updateMany({
      where: { id: itemId, orderId, pickedAt: picked ? null : { not: null } },
      data: picked ? { pickedAt: new Date(), pickedById: user.id } : { pickedAt: null, pickedById: null },
    });
    const item = await this.prisma.orderItem.findFirst({
      where: { id: itemId, orderId },
      include: { pickedBy: { select: { id: true, fullName: true } } },
    });
    if (!item) throw new NotFoundException('Order item not found');
    if (changed.count === 1) {
      this.log.log(`Pick ${order.orderNumber} item ${itemId} ${picked ? 'ticked' : 'unticked'} by ${user.id}`);
    }
    return { id: item.id, pickedAt: item.pickedAt, pickedBy: item.pickedBy };
  }

  /**
   * Newest first, one page at a time. `q` matches the order number, phone or customer name (the database
   * collation folds Latin case only, so Cyrillic names match as typed or with a capital first letter).
   */
  async list(user: AuthUser, status?: OrderStatus, filter: { q?: string; from?: string; to?: string; skip?: number; take?: number } = {}) {
    if (user.role === Role.ACHIGCH_BELTGEGCH) {
      throw new ForbiddenException('Warehouse staff must use /orders/tickets');
    }
    const and: Prisma.OrderWhereInput[] = [await this.orderScope(user)];
    if (status && status in OrderStatus) and.push({ status });
    const q = filter.q?.trim();
    if (q) {
      const cap = q.charAt(0).toUpperCase() + q.slice(1);
      and.push({
        OR: [
          { orderNumber: { contains: q, mode: 'insensitive' } },
          { customerPhone: { contains: q } },
          { customerName: { contains: q, mode: 'insensitive' } },
          { customerName: { contains: cap } },
          // Registered customers also match in the other alphabet ("ondor" finds "Өндөр Барилга").
          ...(searchKey(q) ? [{ customer: { searchText: { contains: searchKey(q) } } }] : []),
        ],
      });
    }
    const day = (d: string | undefined, end: boolean) =>
      d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T${end ? '23:59:59.999' : '00:00:00.000'}+08:00`) : undefined;
    const gte = day(filter.from, false);
    const lte = day(filter.to, true);
    if (gte || lte) and.push({ createdAt: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } });
    const take = Math.min(Math.max(Number(filter.take) || 50, 1), 200);
    const skip = Math.max(Number(filter.skip) || 0, 0);
    const rows = await this.prisma.order.findMany({
      where: { AND: and },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
    return this.presentOrders(rows, user.role);
  }

  async listReleaseTickets(user: AuthUser) {
    if (!isWarehouseActor(user.role)) {
      throw new ForbiddenException('Warehouse staff, cashiers, managers, or admin can view release tickets');
    }
    const scope = await this.orderScope(user);
    const rows = await this.prisma.order.findMany({
      where: { status: OrderStatus.READY_FOR_LOADING, ...scope },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return this.presentOrders(rows, user.role);
  }

  async listRecentlyPrepared(user: AuthUser) {
    if (!isWarehouseActor(user.role)) {
      throw new ForbiddenException('Warehouse staff, cashiers, managers, or admin can view release tickets');
    }
    const scope = await this.orderScope(user);
    const rows = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.COMPLETED,
        preparedById: { not: null },
        ...scope,
      },
      include: ORDER_INCLUDE,
      orderBy: { preparedAt: 'desc' },
      take: 200,
    });
    return this.presentOrders(rows, user.role);
  }

  async assignDriver(orderId: string, dto: AssignDriverDto, user: AuthUser) {
    if (!isTransportActor(user.role)) {
      throw new ForbiddenException('Only warehouse staff, managers, or admin can record hired transport notes');
    }
    if (this.features) await this.features.assertEnabled('DELIVERY');
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    if (!isHiredTransport(order.deliveryMethod)) {
      throw new BadRequestException('Hired transport notes apply only to company delivery (not self-pickup or customer driver)');
    }
    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('Cannot update transport on a cancelled order');
    }
    const hired = this.hiredTransportNotes(order.deliveryMethod, order, dto);
    if (!hired) {
      throw new BadRequestException('Hired transport notes apply only to company delivery (not self-pickup or customer driver)');
    }
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        vehicleNumber: hired.vehicleNumber,
        driverPhone: hired.driverPhone,
        driverName: hired.driverName,
      },
    });
    this.log.log(
      `Hired transport ${hired.vehicleNumber} / ${hired.driverPhone} on ${order.orderNumber} by ${user.fullName ?? user.name} (${user.id})`,
    );
    return this.findOne(orderId, user);
  }

  async assignSupplier(orderId: string, itemId: string, dto: AssignSupplierDto, user: AuthUser) {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER) {
      throw new ForbiddenException('Only managers or admin can assign an external supplier');
    }
    const supplierName = dto.supplierName.trim();
    if (supplierName.length < 2) {
      throw new BadRequestException('supplierName is required');
    }

    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const updated = await this.prisma.$transaction(
          async (tx) => {
            const item = await tx.orderItem.findFirst({
              where: { id: itemId, orderId },
              include: { product: true, returnItems: true, payables: true, order: true },
            });
            if (!item) throw new NotFoundException('Order item not found');
            if (item.order.status === OrderStatus.CANCELLED) {
              throw new BadRequestException('Cannot reconcile a cancelled order');
            }
            if (item.sourceType === SourceType.EXTERNAL_SUPPLIER) {
              throw new BadRequestException('Line is already marked as external supplier');
            }

            const returned = item.returnItems.reduce(
              (sum, row) => sum.plus(row.quantity),
              new Prisma.Decimal(0),
            );
            const remaining = new Prisma.Decimal(item.quantity.toString()).minus(returned);
            if (remaining.lte(0)) {
              throw new BadRequestException('No remaining quantity to assign to a supplier');
            }

            // The stock was taken from the order's warehouse, so it is given back there (and ledgered).
            let restored = new Prisma.Decimal(0);
            let stockBefore: Prisma.Decimal;
            let stockAfter: Prisma.Decimal;
            if (item.order.status === OrderStatus.COMPLETED) {
              restored = remaining;
              const moved = await this.inventory.reconcileRestore(tx, item.productId, remaining, {
                warehouseId: item.order.warehouseId,
                refType: 'ORDER',
                refId: orderId,
                reason: `Supplier "${supplierName}" delivered ${item.order.orderNumber}`,
                actorId: user.id,
              });
              stockBefore = moved.before;
              stockAfter = moved.after;
            } else {
              const warehouseId = item.order.warehouseId ?? (await this.inventory.defaultWarehouseId(tx));
              const balance = await tx.stockBalance.findUnique({
                where: { warehouseId_productId: { warehouseId, productId: item.productId } },
              });
              stockBefore = new Prisma.Decimal((balance?.quantity ?? 0).toString());
              stockAfter = stockBefore;
            }

            await tx.orderItem.update({
              where: { id: itemId },
              data: { sourceType: SourceType.EXTERNAL_SUPPLIER, supplierName },
            });

            const amountMnt = Math.round(item.unitPrice * Number(remaining));
            const openPayable = item.payables.find((p) => p.status === 'OPEN');
            if (openPayable) {
              await tx.supplierPayable.update({
                where: { id: openPayable.id },
                data: { supplierName, quantity: remaining, amountMnt },
              });
            } else {
              await tx.supplierPayable.create({
                data: {
                  orderId,
                  orderItemId: itemId,
                  supplierName,
                  quantity: remaining,
                  amountMnt,
                },
              });
            }

            await tx.stockReconciliationAudit.create({
              data: {
                orderId,
                orderItemId: itemId,
                productId: item.productId,
                actorId: user.id,
                previousSourceType: SourceType.INTERNAL,
                supplierName,
                quantityRestored: restored,
                stockBefore,
                stockAfter,
                amountMnt,
                reason: dto.reason?.trim() || null,
              },
            });

            this.log.log(
              `Reconcile ${item.order.orderNumber} item ${itemId} ${item.product.sku} qty=${remaining.toString()} stock ${stockBefore.toString()}→${stockAfter.toString()} supplier="${supplierName}" by ${user.name} (${user.id})`,
            );
            return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        return this.presentOrder(updated, user.role);
      } catch (err) {
        lastError = err;
        const code = (err as { code?: string }).code;
        if (code === 'P2034' && attempt < maxAttempts) {
          this.log.warn(`Supplier assign retry ${attempt} for order ${orderId} (serialization conflict)`);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async findOne(id: string, user: AuthUser) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    if (user.role === Role.ACHIGCH_BELTGEGCH && order.status === OrderStatus.PENDING_PAYMENT) {
      throw new ForbiddenException();
    }
    return this.presentOrder(order, user.role);
  }

  async issueEbarimt(orderId: string, user: AuthUser) {
    if (user.role !== Role.BORLUULAGCH && user.role !== Role.ADMIN && user.role !== Role.MANAGER) {
      throw new ForbiddenException('Only cashiers, managers, or admin can issue E-Barimt');
    }
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    await this.ebarimt.issueForOrder(orderId, { quiet: false });
    return this.findOne(orderId, user);
  }

  private presentOrder<T extends { lottery?: string | null; qrCode?: string | null; ebarimtStatus?: string | null; ebarimtError?: string | null }>(
    order: T,
    role: Role,
  ): T {
    if (role !== Role.BORLUULAGCH) return order;
    return {
      ...order,
      lottery: null,
      qrCode: null,
      ebarimtPayload: null,
      ebarimtError: order.ebarimtStatus === 'FAILED' ? 'И-Баримт олгоход алдаа гарлаа' : null,
    } as T;
  }

  private presentOrders<T extends { lottery?: string | null; qrCode?: string | null; ebarimtStatus?: string | null; ebarimtError?: string | null }>(
    rows: T[],
    role: Role,
  ) {
    return rows.map((row) => this.presentOrder(row, role));
  }

}
